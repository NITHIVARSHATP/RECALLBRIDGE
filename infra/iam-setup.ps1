param(
    [string]$ProjectId = $(gcloud config get-value project 2>$null),
    [string]$ServiceAccountId = "recallbridge-function",
    [string[]]$SecretNames = @("GEMINI_API_KEY", "RECAPTCHA_SECRET_KEY")
)

if (-not $ProjectId) {
    throw "Set a Google Cloud project via gcloud config or pass -ProjectId explicitly."
}

$serviceAccountEmail = "$ServiceAccountId@$ProjectId.iam.gserviceaccount.com"

Write-Host "Creating service account $serviceAccountEmail if missing..."
gcloud iam service-accounts create $ServiceAccountId `
    --project $ProjectId `
    --description "RecallBridge Functions runtime" `
    --display-name "RecallBridge Functions" 2>$null | Out-Null

Write-Host "Granting project-level monitoring metric writer..."
gcloud projects add-iam-policy-binding $ProjectId `
    --member "serviceAccount:$serviceAccountEmail" `
    --role "roles/monitoring.metricWriter" `
    --quiet

foreach ($secret in $SecretNames) {
    $secretResource = "projects/$ProjectId/secrets/$secret"
    Write-Host "Binding Secret Manager accessor for $secretResource"
    gcloud secrets add-iam-policy-binding $secretResource `
        --member "serviceAccount:$serviceAccountEmail" `
        --role "roles/secretmanager.secretAccessor" `
        --quiet
}

Write-Host "Service account ready. Update firebase.json runtimeOptions or deploy via Firebase CLI with --service-account $serviceAccountEmail so only this identity executes RecallBridge."