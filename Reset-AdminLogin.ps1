$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$envFile = Join-Path $PSScriptRoot ".env"
$databaseFile = Join-Path $PSScriptRoot "store.sqlite"
$backupPath = Join-Path $PSScriptRoot ".env.reset.bak"
if (-not (Test-Path -LiteralPath $envFile -PathType Leaf)) {
    throw "Khong tim thay .env. Hay chay script trong thu muc cai dat cua cua hang."
}
if (-not (Test-Path -LiteralPath $databaseFile -PathType Leaf)) {
    throw "Khong tim thay store.sqlite. Dung lai va xac nhan dung thu muc du an truoc khi dat lai."
}
if (Test-Path -LiteralPath $backupPath) {
    throw "Da ton tai .env.reset.bak. Hay kiem tra tep nay truoc khi chay lai; khong thay doi tep."
}

$lines = [System.Collections.Generic.List[string]]::new()
$lines.AddRange([string[]][IO.File]::ReadAllLines($envFile))
$keys = @{}
for ($index = 0; $index -lt $lines.Count; $index++) {
    if ($lines[$index] -match '^\s*([A-Z][A-Z0-9_]*)=') {
        $key = $Matches[1]
        if (-not $keys.ContainsKey($key)) {
            $keys[$key] = [System.Collections.Generic.List[int]]::new()
        }
        $keys[$key].Add($index)
    }
}

foreach ($required in @("ACCOUNT_ENCRYPTION_KEY", "ADMIN_USERNAME_B64", "ADMIN_PASSWORD_HASH", "ADMIN_PASSWORD_SALT")) {
    if (-not $keys.ContainsKey($required) -or $keys[$required].Count -ne 1) {
        throw "Cau hinh .env thieu hoac trung bien $required; khong thay doi tep."
    }
}

$encryptionLine = $lines[$keys["ACCOUNT_ENCRYPTION_KEY"][0]]
$usernameLine = $lines[$keys["ADMIN_USERNAME_B64"][0]]
$hashLine = $lines[$keys["ADMIN_PASSWORD_HASH"][0]]
$saltLine = $lines[$keys["ADMIN_PASSWORD_SALT"][0]]
if ($encryptionLine -notmatch '^ACCOUNT_ENCRYPTION_KEY=([a-f\d]{64})$') {
    throw "Khoa ma hoa hien tai khong hop le; khong thay doi tep."
}
if ($usernameLine -notmatch '^ADMIN_USERNAME_B64=([A-Za-z0-9+/]+={0,2})$') {
    throw "Ten dang nhap hien tai khong hop le; khong thay doi tep."
}
if ($hashLine -notmatch '^ADMIN_PASSWORD_HASH=[a-f\d]{64}$' -or $saltLine -notmatch '^ADMIN_PASSWORD_SALT=[a-f\d]{32}$') {
    throw "Hash mat khau hien tai khong hop le; khong thay doi tep."
}

$confirmation = Read-Host "Nhap RESET-ADMIN de doi rieng thong tin dang nhap quan tri"
if ($confirmation -cne "RESET-ADMIN") {
    Write-Host "Da huy; .env, khoa ma hoa va database khong thay doi."
    exit 0
}

$adminUsername = (Read-Host "Ten dang nhap quan tri moi, toi thieu 3 ky tu").Trim()
if ($adminUsername.Length -lt 3 -or $adminUsername.Length -gt 128) {
    throw "Ten dang nhap can dai tu 3 den 128 ky tu."
}

$securePassword = Read-Host "Mat khau moi, it nhat 12 ky tu" -AsSecureString
$passwordPointer = [IntPtr]::Zero
$salt = New-Object byte[] 16
$temporaryPath = Join-Path $PSScriptRoot ".env.reset.tmp"
$passwordDerivation = $null
$generator = $null
try {
    $passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
    $adminPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
    if ($adminPassword.Length -lt 12 -or $adminPassword.Length -gt 256) {
        throw "Mat khau can dai tu 12 den 256 ky tu."
    }

    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    $generator.GetBytes($salt)
    $passwordDerivation = [Security.Cryptography.Rfc2898DeriveBytes]::new(
        $adminPassword,
        $salt,
        310000,
        [Security.Cryptography.HashAlgorithmName]::SHA256
    )
    $passwordHash = [BitConverter]::ToString($passwordDerivation.GetBytes(32)).Replace("-", "")
    $passwordSalt = [BitConverter]::ToString($salt).Replace("-", "")
    $usernameBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($adminUsername))

    $updatedLines = [string[]]$lines.ToArray()
    $updatedLines[$keys["ADMIN_USERNAME_B64"][0]] = "ADMIN_USERNAME_B64=$usernameBase64"
    $updatedLines[$keys["ADMIN_PASSWORD_HASH"][0]] = "ADMIN_PASSWORD_HASH=$passwordHash"
    $updatedLines[$keys["ADMIN_PASSWORD_SALT"][0]] = "ADMIN_PASSWORD_SALT=$passwordSalt"

    [IO.File]::WriteAllLines($temporaryPath, $updatedLines, [Text.UTF8Encoding]::new($false))
    [IO.File]::Replace($temporaryPath, $envFile, $backupPath)
}
finally {
    if ($passwordDerivation) { $passwordDerivation.Dispose() }
    if ($generator) { $generator.Dispose() }
    [Array]::Clear($salt, 0, $salt.Length)
    if ($passwordPointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
    }
    $securePassword.Dispose()
    if (Test-Path -LiteralPath $temporaryPath -PathType Leaf) {
        Remove-Item -LiteralPath $temporaryPath -Force
    }
    if (Test-Path -LiteralPath $backupPath -PathType Leaf) {
        Remove-Item -LiteralPath $backupPath -Force
    }
}

Write-Host "Da cap nhat thong tin quan tri. Khoa ma hoa, tai khoan acc va don hang duoc giu nguyen." -ForegroundColor Green
Write-Host "Hay dung may chu dang chay bang Ctrl+C, chay lai .\Start-Store.ps1, roi dang nhap bang ten va mat khau moi."
