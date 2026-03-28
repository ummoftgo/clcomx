$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = 'wsl.exe'
$psi.Arguments = '-d Ubuntu-20.04 -e tmux -CC new-session -A -s clcomx-probe-win'
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.UseShellExecute = $false

$p = [System.Diagnostics.Process]::Start($psi)
Start-Sleep -Milliseconds 700

$buf = New-Object byte[] 4096
$n = $p.StandardOutput.BaseStream.Read($buf, 0, $buf.Length)
Write-Output ('FIRST_BYTES_LEN=' + $n)
if ($n -gt 0) {
  $slice = [System.Text.Encoding]::UTF8.GetString($buf, 0, $n)
  Write-Output ($slice.Replace([char]27, '<ESC>'))
}

$cmd = [System.Text.Encoding]::UTF8.GetBytes("list-panes -F '#{pane_id}`t#{pane_active}`n'`n")
$p.StandardInput.BaseStream.Write($cmd, 0, $cmd.Length)
$p.StandardInput.BaseStream.Flush()
Start-Sleep -Milliseconds 700

$n2 = $p.StandardOutput.BaseStream.Read($buf, 0, $buf.Length)
Write-Output ('SECOND_BYTES_LEN=' + $n2)
if ($n2 -gt 0) {
  $slice2 = [System.Text.Encoding]::UTF8.GetString($buf, 0, $n2)
  Write-Output ($slice2.Replace([char]27, '<ESC>'))
}

$kill = [System.Text.Encoding]::UTF8.GetBytes("kill-session -t clcomx-probe-win`n")
$p.StandardInput.BaseStream.Write($kill, 0, $kill.Length)
$p.StandardInput.BaseStream.Flush()
Start-Sleep -Milliseconds 200

if (!$p.HasExited) {
  $p.Kill()
}
