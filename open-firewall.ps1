# Mo port 3000 tren Windows Firewall de may khac trong mang noi bo truy cap duoc.
# Chay bang quyen Administrator:  powershell -ExecutionPolicy Bypass -File open-firewall.ps1

$rule = 'Runway Studio (3000)'

if (Get-NetFirewallRule -DisplayName $rule -ErrorAction SilentlyContinue) {
    Write-Host "Rule '$rule' da ton tai." -ForegroundColor Yellow
} else {
    New-NetFirewallRule -DisplayName $rule `
        -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3000 `
        -Profile Private | Out-Null
    Write-Host "Da mo port 3000 cho mang Private." -ForegroundColor Green
}

Write-Host "`nDia chi de dong nghiep truy cap:" -ForegroundColor Cyan
Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
    ForEach-Object { Write-Host "  http://$($_.IPAddress):3000" }
