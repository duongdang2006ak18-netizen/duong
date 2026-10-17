param(
    [switch]$ResetConfig
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$node = Get-Command node.exe -ErrorAction SilentlyContinue
$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
$nodePath = if ($node) { $node.Source } else { "" }
if (-not $node) {
    $nodeCandidate = Get-ChildItem -Path (Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages") -Filter node.exe -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($nodeCandidate) {
        $node = $nodeCandidate
        $nodePath = $node.FullName
        $env:PATH = "$(Split-Path $nodePath);$env:PATH"
    }
}
if (-not $npm -and $node) {
    $npmCandidate = Join-Path (Split-Path $nodePath) "npm.cmd"
    if (Test-Path $npmCandidate) {
        $npm = Get-Item $npmCandidate
    }
}
$npmPath = if ($npm -is [System.IO.FileInfo]) { $npm.FullName } elseif ($npm) { $npm.Source } else { "" }
if (-not $node -or -not $npm) {
    Write-Host "Can cai Node.js 22.13 tro len (kem npm) truoc khi chay." -ForegroundColor Yellow
    Write-Host "Tai ban LTS tai https://nodejs.org/ roi mo lai PowerShell."
    exit 1
}

$nodeVersion = (& $nodePath --version).TrimStart("v")
if ([version]$nodeVersion -lt [version]"22.13") {
    Write-Host "Can Node.js 22.13 tro len. Phien ban hien tai: $nodeVersion" -ForegroundColor Red
    exit 1
}

$envFile = Join-Path $PSScriptRoot ".env"
if ($ResetConfig -or -not (Test-Path $envFile)) {
    if ((Test-Path $envFile) -and $ResetConfig) {
        Write-Host "Thay cau hinh se khong giai ma duoc acc cu neu doi khoa ma hoa." -ForegroundColor Yellow
        $confirmation = Read-Host "Nhap RESET de tao cau hinh moi"
        if ($confirmation -cne "RESET") {
            Write-Host "Da huy. Cau hinh cu duoc giu nguyen."
            exit 0
        }
    }

    Write-Host "Cau hinh lan dau. Thong tin duoc luu trong .env tren may nay, khong gui vao chat." -ForegroundColor Cyan
    $adminUsername = (Read-Host "Ten dang nhap quan tri, toi thieu 3 ky tu").Trim()
    if ($adminUsername.Length -lt 3) {
        throw "Ten dang nhap quan tri qua ngan."
    }
    $securePassword = Read-Host "Mat khau quan tri, toi thieu 12 ky tu" -AsSecureString
    $passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
    try {
        $adminPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
    }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
    }
    if ($adminPassword.Length -lt 12) {
        throw "Mat khau quan tri phai co it nhat 12 ky tu."
    }

    $bankCode = (Read-Host "Ma ngan hang VietQR, vi du MB, VCB, TCB").Trim()
    $bankAccount = (Read-Host "So tai khoan nhan tien, 6-24 chu so").Trim()
    $bankAccountName = (Read-Host "Ten chu tai khoan, dung nhu ten tren ngan hang").Trim()
    if ($bankCode -notmatch '^[a-zA-Z0-9-]{2,24}$') {
        throw "Ma ngan hang VietQR chua dung dinh dang."
    }
    if ($bankAccount -notmatch '^\d{6,24}$') {
        throw "So tai khoan can co 6-24 chu so."
    }
    if ($bankAccountName.Length -lt 2 -or $bankAccountName.Length -gt 100) {
        throw "Ten chu tai khoan can co 2-100 ky tu."
    }

    $randomKey = New-Object byte[] 32
    $adminSalt = New-Object byte[] 16
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $generator.GetBytes($randomKey)
        $generator.GetBytes($adminSalt)
    }
    finally {
        $generator.Dispose()
    }
    $encryptionKey = [BitConverter]::ToString($randomKey).Replace("-", "")
    $passwordDerivation = [Security.Cryptography.Rfc2898DeriveBytes]::new($adminPassword, $adminSalt, 310000, [Security.Cryptography.HashAlgorithmName]::SHA256)
    try {
        $passwordHash = [BitConverter]::ToString($passwordDerivation.GetBytes(32)).Replace("-", "")
    }
    finally {
        $passwordDerivation.Dispose()
    }
    $passwordSaltHex = [BitConverter]::ToString($adminSalt).Replace("-", "")
    [Array]::Clear($randomKey, 0, $randomKey.Length)
    [Array]::Clear($adminSalt, 0, $adminSalt.Length)
    $username64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($adminUsername))
    $accountName64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($bankAccountName))
    $lines = @(
        "PORT=3000",
        "ACCOUNT_ENCRYPTION_KEY=$encryptionKey",
        "ADMIN_USERNAME_B64=$username64",
        "ADMIN_PASSWORD_HASH=$passwordHash",
        "ADMIN_PASSWORD_SALT=$passwordSaltHex",
        "BANK_CODE=$bankCode",
        "BANK_ACCOUNT=$bankAccount",
        "BANK_ACCOUNT_NAME_B64=$accountName64"
    )
    [IO.File]::WriteAllLines($envFile, $lines, [Text.UTF8Encoding]::new($false))
    $adminPassword = $null
    $passwordHash = $null
    Write-Host "Da tao .env va khoa ma hoa rieng. Hay sao luu ca .env va store.sqlite an toan." -ForegroundColor Green
}

if (-not (Test-Path (Join-Path $PSScriptRoot "node_modules\express"))) {
    Write-Host "Dang cai cac goi phu thuoc..."
    & $npmPath ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) {
        throw "npm ci that bai. Kiem tra ket noi mang va thu lai."
    }
}

$npmVersion = (& $npmPath --version).Trim()
if ([int]$npmVersion.Split(".")[0] -ge 11 -and -not (Test-Path (Join-Path $PSScriptRoot "node_modules\better-sqlite3\build\Release\better_sqlite3.node"))) {
    Write-Host "Cho phep cai dat SQLite native tu goi better-sqlite3 da duoc khoa phien ban..."
    & $npmPath install-scripts approve better-sqlite3
    if ($LASTEXITCODE -ne 0) {
        throw "Khong the khoi tao better-sqlite3. Kiem tra huong dan cai dat Node.js va thu lai."
    }
}

Write-Host "Khoi dong OVR CLUB tai http://localhost:3000"
& $npmPath start
if ($LASTEXITCODE -ne 0) {
    throw "May chu dung voi ma loi $LASTEXITCODE."
}
