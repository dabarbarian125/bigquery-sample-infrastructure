import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";
import * as command from "@pulumi/command";

const config = new pulumi.Config();
const configGCP = new pulumi.Config("gcp");
const projectId = configGCP.requireSecret("project");
const region = "us-east1";

// Enable neccesary APIs
const bigqueryApi = new gcp.projects.Service("enable-bigquery-api", {
    project: projectId,
    service: "bigquery.googleapis.com",
});

const enableDataprocApi = new gcp.projects.Service("enableDataprocApi", {
    service: "dataproc.googleapis.com", 
    project: projectId,
    disableOnDestroy: false, 
});

// Service accounts
const lookerServiceAccount = new gcp.serviceaccount.Account("looker-service-account", {
    accountId: "looker-sa", 
    displayName: "Looker BigQuery Access Service Account", 
});

const dataprocServiceAccount = new gcp.serviceaccount.Account("dataproc-service-account", {
    accountId: "dataproc-sa",
    displayName: "Dataproc Service Account",
});

// Assign necessary IAM roles to the service account
const dataprocWorkerRole = new gcp.projects.IAMMember("dataprocWorkerRole", {
    project: projectId,
    role: "roles/dataproc.worker", 
    member: pulumi.interpolate`serviceAccount:${dataprocServiceAccount.email}`,
});

const storageRole = new gcp.projects.IAMMember("storageRole", {
    project: projectId,
    role: "roles/storage.objectAdmin",
    member: pulumi.interpolate`serviceAccount:${dataprocServiceAccount.email}`,
});

const bigqueryRole = new gcp.projects.IAMMember("bigqueryRole", {
    project: projectId,
    role: "roles/bigquery.user",
    member: pulumi.interpolate`serviceAccount:${dataprocServiceAccount.email}`,
});

// Assign BigQuery Data Editor role
const bigqueryDataEditorRole = new gcp.projects.IAMMember("bigqueryDataEditorRole", {
    project: projectId,
    role: "roles/bigquery.dataEditor",
    member: pulumi.interpolate`serviceAccount:${dataprocServiceAccount.email}`,
});

// Assign BigQuery Job User role
const bigqueryJobUserRole = new gcp.projects.IAMMember("bigqueryJobUserRole", {
    project: projectId,
    role: "roles/bigquery.jobUser",
    member: pulumi.interpolate`serviceAccount:${dataprocServiceAccount.email}`,
});

const datasetIAMRole = new gcp.bigquery.DatasetIamMember("datasetRole", {
    datasetId: "sample_project_results",
    project: "big-query-sample-444520",
    role: "roles/bigquery.dataEditor",
    member: pulumi.interpolate`serviceAccount:${dataprocServiceAccount.email}`,
});


const bigQueryRoleBinding = new gcp.projects.IAMBinding("looker-bigquery-access", {
    project: projectId, 
    role: "roles/bigquery.dataViewer", 
    members: [pulumi.interpolate`serviceAccount:${lookerServiceAccount.email}`],
});

const customBigQueryRole = new gcp.projects.IAMCustomRole("custom-bigquery-role", {
    roleId: "customBigQueryDataViewer",
    title: "Custom BigQuery Data Viewer",
    description: "Custom role for viewing BigQuery data",
    permissions: [
        "bigquery.datasets.get",
        "bigquery.tables.get",
        "bigquery.tables.list",
        "bigquery.jobs.create",
    ],
});



const sampleProjectDataset = new gcp.bigquery.Dataset("sample-project-dataset", {
    project: projectId,
    datasetId: "sample_project_results",
    location: "US",
    accesses: [
        {
            role: "roles/bigquery.dataOwner",
            userByEmail: config.requireSecret("owner")
        },
        {
            role: customBigQueryRole.name,
            userByEmail: lookerServiceAccount.email,
        },
    ],
});

// Table, Query and Job for Query 1
const geographicTable = new gcp.bigquery.Table("geographic-table", {
    datasetId: sampleProjectDataset.datasetId,
    tableId: "zipcode_counts",
    project: projectId,
    schema:  `[
            { "name": "postalCode", "type": "STRING" },
            { "name": "patients", "type": "INTEGER" }
        ]
    `,
    deletionProtection: false,
});

const geographicQuery = `
SELECT
  address_entry.postalCode,
  COUNT(*) as patients
FROM \`bigquery-public-data.fhir_synthea.patient\`,
UNNEST(address) AS address_entry
WHERE id in (
  SELECT DISTINCT subject.patientId
  FROM
    \`bigquery-public-data.fhir_synthea.observation\`,
    UNNEST(code.coding) AS coding_entry
  WHERE
    CAST(coding_entry.code AS STRING) IN ("87626-8", "84215-3", "75443-2", "71802-3")
  
  UNION DISTINCT
  
  SELECT DISTINCT subject.patientId
  FROM
    \`bigquery-public-data.fhir_synthea.condition\`,
    UNNEST(code.coding) AS coding_entry
  WHERE
    CAST(coding_entry.code AS STRING) IN ("36923009", "225444004", "370143000", "287185009", "86849004", "287182007")
)
GROUP BY address_entry.postalCode
`

const queryJob = projectId.apply((resolvedProjectId) =>
    new gcp.bigquery.Job("patient-query-job", {
        project: resolvedProjectId, 
        location: "US", 
        jobId: `patient-geographical-distribution-${new Date().toISOString().replace(/[:.]/g, "-")}`, 
        query: {
            query: geographicQuery,
            useLegacySql: false,
            destinationTable: {
                projectId: resolvedProjectId,
                datasetId: sampleProjectDataset.datasetId,
                tableId: geographicTable.tableId,
            },
            writeDisposition: "WRITE_TRUNCATE", 
        },
    })
);

// Query 2 Using Python 
// const cluster = new gcp.dataproc.Cluster("pyspark-dataproc-cluster", {
//     region: region,
//     clusterConfig: {
//         masterConfig: {
//             numInstances: 1,
//             machineType: "n1-standard-4",
//             diskConfig: {
//                 bootDiskSizeGb: 100,
//                 numLocalSsds: 0,
//             },
//         },
//         workerConfig: {
//             numInstances: 2,
//             machineType: "n1-standard-4",
//             diskConfig: {
//                 bootDiskSizeGb: 100,
//                 numLocalSsds: 0,
//             },
//         },
//         softwareConfig: {
//             imageVersion: "2.1", 
//             optionalComponents: ["JUPYTER"],
            
//         },
//         gceClusterConfig: {
//             serviceAccount: dataprocServiceAccount.email,
//             serviceAccountScopes: [
//                 "https://www.googleapis.com/auth/cloud-platform",
//             ],
   
//         },
//     },
// });
const cluster = "pyspark-dataproc-cluster";
const enableComponentGateway = new command.local.Command("enableComponentGateway", {
    create: pulumi.interpolate`
    gcloud dataproc clusters create ${cluster} \
    --region=${region} \
    --project=${projectId} \
    --enable-component-gateway \
    --optional-components=JUPYTER \
    --image-version=2.1-debian11 \
    --num-masters=1 --master-machine-type=n1-standard-2 \
    --num-workers=2 --worker-machine-type=n1-standard-2
    `,
});

// This is the point where my IAC breaks down, as I have to upload the credential file to GCS and inject certain generated values into my .ipynb file. This is work I could easily do, but it seems outside the scope of this project. I will continue to work on it, but the automated provisioning of a PySpark data job will need to wait for another day.

// Define the table schema
const ageTableSchema = `
    [
        { "name": "age_group", "type": "STRING", "mode": "NULLABLE" },
        { "name": "overall_claims", "type": "INT64", "mode": "NULLABLE" },
        { "name": "overall_unique_patients", "type": "INT64", "mode": "NULLABLE" },
        { "name":"avg_overall_claims", "type": "FLOAT64", "mode": "REQUIRED" },
        { "name": "target_claims", "type": "INT64", "mode": "NULLABLE" },
        { "name": "target_unique_patients", "type": "INT64", "mode": "NULLABLE" },
        { "name": "avg_target_claims", "type": "FLOAT64", "mode": "REQUIRED" }
    ]
`;

// Create the table
const sampleProjectTable = new gcp.bigquery.Table("sample-project-table", {
    project: projectId,
    datasetId: sampleProjectDataset.datasetId,
    tableId: "claims_analysis",
    schema: ageTableSchema, 
});
// Create Looker Dashboard
// I initially believed I could do this with Pulumi, but you can't do much with automated tools. In the future I could look into gcloud tools for this.

// Integrate ML Somehow

// Launch Containerized React/Express Instance to add new data to database and embed looker dashboard
const webAppServiceAccount = new gcp.serviceaccount.Account("webAppServiceAccount", {
    accountId: "web-sa", 
    displayName: "Example Service Account for BigQuery Access",
    project: projectId,
});

// const datasetWriteAccess = new gcp.bigquery.DatasetIamBinding("datasetWriteAccess", {
//     datasetId: sampleProjectDataset.datasetId,
//     project: projectId,
//     role: "roles/bigquery.dataEditor",
//     members: [`serviceAccount:${webAppServiceAccount.email}`],
// });

// // Role: BigQuery Data Viewer for read access
// const datasetReadAccess = new gcp.bigquery.DatasetIamBinding("datasetReadAccess", {
//     datasetId: sampleProjectDataset.datasetId,
//     project: projectId,
//     role: "roles/bigquery.dataViewer",
//     members: [`serviceAccount:${webAppServiceAccount.email}`],
// });


const inpuTable = new gcp.bigquery.Table("input-table", {
    datasetId: sampleProjectDataset.datasetId,
    tableId: "input_counts",
    project: projectId,
    schema:  `[
            { "name": "raw_id", "type": "STRING", "mode": "REQUIRED", "description":  "Auto-generated unique identifier", "defaultValueExpression":  "GENERATE_UUID()"},
            { "name": "int_field", "type": "INTEGER" },
            { "name": "string_field", "type": "STRING" }
        ]
    `,
    deletionProtection: false,
});




const machineType = "e2-medium"; 
const imageFamily = "debian-11"; 
const imageProject = "debian-cloud"; 

// Create a network for the VM
const network = new gcp.compute.Network("vm-network", {
    autoCreateSubnetworks: true,
});

// Create a firewall rule to allow SSH
const firewall = new gcp.compute.Firewall("vm-firewall", {
    network: network.id,
    allows: [
        {
            protocol: "tcp",
            ports: ["22", "80", "8080"], 
        },
    ],
    sourceRanges: ["0.0.0.0/0"],
});

// Create an external IP address for the VM
const externalIp = new gcp.compute.Address("vm-external-ip", {
    region: region,
});

// Create the VM instance
const instance = new gcp.compute.Instance("vm-instance", {
    machineType: machineType,
    zone: "us-east1-b",
    bootDisk: {
        initializeParams: {
            image: pulumi.interpolate`projects/${imageProject}/global/images/family/${imageFamily}`,
        },
    },
    networkInterfaces: [
        {
            network: network.id,
            accessConfigs: [
                {
                    natIp: externalIp.address,
                },
            ],
        },
    ],
    metadataStartupScript: `
        #! /bin/bash
        # Update and install Docker
        sudo apt-get update
        sudo apt-get install -y docker.io
        sudo systemctl start docker
        sudo systemctl enable docker
    `,
    tags: ["allow-ssh"], 
});

// Exports
export const bigQueryApiStatus = bigqueryApi.service;
export const lookerServiceAccountEmail = lookerServiceAccount.email;
export const queryJobId = queryJob.id;
export const vmExternalIp = externalIp.address;
