$root = 'D:\All_project\own\AI_Coder\Native Tools\curl'
Set-Location $root
$files = @('src\index.ts','src\rest-client.ts','package.json','package-lock.json','build\index.js','scripts\run_metrics.ts','thesis_tests\run_bab5_experiments.mjs','thesis_tests\resource_benchmark.mjs','thesis_tests\results\bab5_runs.csv','thesis_tests\results\resource_benchmark.json')
$hashes = @{}
foreach ($f in $files) { if (Test-Path $f) { $hashes[$f] = (Get-FileHash $f -Algorithm SHA256).Hash.ToLower() } }
$cpu = (Get-CimInstance Win32_Processor | Select-Object -First 1 -ExpandProperty Name)
$ram = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB, 2)
$manifest = [ordered]@{
  generated_at = (Get-Date).ToString('o'); thesis_release = '1.4.2'; node = (node --version); npm = (npm --version); typescript = (npx tsc --version); puppeteer = '24.10.0'; chromium = '137.0.7151.55'; os = (Get-CimInstance Win32_OperatingSystem).Caption; cpu = $cpu; ram_gb = $ram; logical_processors = (Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors; primary_dataset_runs = 441; resource_benchmark_operations = 900; hashes = $hashes
}
$manifest | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 'thesis_experiment_manifest.json'
Get-Content 'thesis_experiment_manifest.json'