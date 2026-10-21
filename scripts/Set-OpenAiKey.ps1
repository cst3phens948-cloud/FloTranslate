$ErrorActionPreference = 'Stop'
$project = Join-Path $PSScriptRoot '..\FloState.Web\FloState.Web.csproj'

while ($true) {
    $secureKey = Read-Host 'Paste the complete OpenAI API key, then press Enter' -AsSecureString
    $plainKey = [System.Net.NetworkCredential]::new('', $secureKey).Password
    if ($plainKey.Length -ge 30 -and $plainKey.StartsWith('sk-') -and $plainKey -notmatch '\s') { break }
    Write-Host 'That does not look like a complete OpenAI API key. Nothing was saved; try again.' -ForegroundColor Yellow
    Remove-Variable secureKey, plainKey
}

try {
    @{ 'OpenAI:ApiKey' = $plainKey } | ConvertTo-Json -Compress | dotnet user-secrets set --project $project
    if ($LASTEXITCODE -ne 0) { throw 'dotnet user-secrets could not save the key.' }
    Write-Host 'Key saved. Restart FloState, then check AI settings.'
}
finally {
    Remove-Variable secureKey, plainKey -ErrorAction SilentlyContinue
}
