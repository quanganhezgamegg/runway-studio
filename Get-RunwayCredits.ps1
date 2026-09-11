<#
.SYNOPSIS
    Kiem tra so credit va han muc su dung cua tai khoan Runway.

.DESCRIPTION
    Goi endpoint GET /v1/organization cua Runway API va hien thi:
      - So credit con lai / tran chi tieu thang
      - Han muc (concurrent + daily) cua tung model
      - So luot da dung trong ngay

    API key duoc doc theo thu tu:
      1. Tham so -ApiKey
      2. Bien moi truong $env:RUNWAY_API_KEY
      3. Bien moi truong cap User trong registry (khong can restart terminal)

    Key KHONG BAO GIO duoc in ra man hinh.

.PARAMETER Detailed
    Liet ke han muc cua tat ca model thay vi chi nhung model da dung.

.PARAMETER Json
    Tra ve raw JSON thay vi ban tom tat.

.EXAMPLE
    .\Get-RunwayCredits.ps1
    .\Get-RunwayCredits.ps1 -Detailed
    .\Get-RunwayCredits.ps1 -Json
#>
[CmdletBinding()]
param(
    [string]$ApiKey,
    [switch]$Detailed,
    [switch]$Json
)

$ErrorActionPreference = 'Stop'

$ApiBase    = 'https://api.dev.runwayml.com/v1'
$ApiVersion = '2024-11-06'

function Get-RunwayApiKey {
    param([string]$Explicit)

    if ($Explicit)              { return $Explicit }
    if ($env:RUNWAY_API_KEY)    { return $env:RUNWAY_API_KEY }

    # Doc thang tu registry: hoat dong ngay ca khi terminal chua restart
    $fromRegistry = [Environment]::GetEnvironmentVariable('RUNWAY_API_KEY', 'User')
    if ($fromRegistry) { return $fromRegistry }

    throw "Khong tim thay API key. Dat bien moi truong RUNWAY_API_KEY hoac truyen -ApiKey."
}

function Format-Number {
    param([Parameter(ValueFromPipeline = $true)]$Value)
    process { '{0:N0}' -f $Value }
}

try {
    $key = Get-RunwayApiKey -Explicit $ApiKey

    $headers = @{
        'Authorization'     = "Bearer $key"
        'X-Runway-Version'  = $ApiVersion
    }

    $response = Invoke-RestMethod -Uri "$ApiBase/organization" -Headers $headers -Method Get
}
catch {
    $status = $null
    if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }

    switch ($status) {
        401     { Write-Host "LOI 401: API key khong hop le hoac da bi revoke." -ForegroundColor Red }
        403     { Write-Host "LOI 403: Key hop le nhung khong du quyen truy cap endpoint nay." -ForegroundColor Red }
        429     { Write-Host "LOI 429: Vuot han muc request, thu lai sau." -ForegroundColor Red }
        default { Write-Host "LOI goi API: $($_.Exception.Message)" -ForegroundColor Red }
    }
    exit 1
}
finally {
    # Xoa key khoi bo nho ngay sau khi dung
    if (Get-Variable key -ErrorAction SilentlyContinue) { Remove-Variable key }
    if (Get-Variable headers -ErrorAction SilentlyContinue) { Remove-Variable headers }
}

if ($Json) {
    $response | ConvertTo-Json -Depth 10
    exit 0
}

# ---------- Tom tat credit ----------
$balance   = $response.creditBalance
$maxSpend  = $response.tier.maxMonthlyCreditSpend

Write-Host ''
Write-Host '  RUNWAY ACCOUNT' -ForegroundColor Cyan
Write-Host '  --------------------------------------------'

$balanceColor = if ($balance -lt 100) { 'Red' } elseif ($balance -lt 500) { 'Yellow' } else { 'Green' }
Write-Host '  Credit con lai      : ' -NoNewline
Write-Host (Format-Number $balance) -ForegroundColor $balanceColor

Write-Host '  Tran chi tieu/thang : ' -NoNewline
Write-Host (Format-Number $maxSpend)

if ($maxSpend -gt 0) {
    $pct = [math]::Round(($balance / $maxSpend) * 100, 1)
    Write-Host "  Ty le con lai       : $pct% cua tran thang"
}

# ---------- Han muc va usage theo model ----------
$tierModels  = $response.tier.models
$usageModels = $response.usage.models

$rows = foreach ($prop in $tierModels.PSObject.Properties) {
    $name  = $prop.Name
    $limit = $prop.Value
    $used  = 0
    if ($usageModels.PSObject.Properties.Name -contains $name) {
        $used = $usageModels.$name.dailyGenerations
    }

    [pscustomobject]@{
        Model      = $name
        Used       = $used
        DailyLimit = $limit.maxDailyGenerations
        Remaining  = $limit.maxDailyGenerations - $used
        Concurrent = $limit.maxConcurrentGenerations
    }
}

$totalUsed = ($rows | Measure-Object -Property Used -Sum).Sum

Write-Host '  Model kha dung      : ' -NoNewline
Write-Host (@($rows).Count)
Write-Host '  Da tao hom nay      : ' -NoNewline
Write-Host "$totalUsed generations"
Write-Host ''

$toShow = if ($Detailed) { $rows | Sort-Object Model } else { $rows | Where-Object { $_.Used -gt 0 } | Sort-Object -Property Used -Descending }

if (@($toShow).Count -eq 0) {
    Write-Host '  Chua dung model nao hom nay. Dung -Detailed de xem toan bo han muc.' -ForegroundColor DarkGray
}
else {
    $toShow | Format-Table -AutoSize @(
        @{ Label = 'Model';        Expression = { $_.Model } }
        @{ Label = 'Dung/Ngay';    Expression = { "$($_.Used)/$($_.DailyLimit)" } }
        @{ Label = 'Con lai';      Expression = { $_.Remaining } }
        @{ Label = 'Song song';    Expression = { $_.Concurrent } }
    )
}

Write-Host ''
