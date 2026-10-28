param([switch]$CheckOnly)

$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

# Read/write only the mandatory label, never the file's owner, DACL or audit ACL.
# A Low-labelled executable starts at Low integrity even from a normal terminal.
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;

public static class BlodeRuntimeIntegrity {
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern uint GetNamedSecurityInfo(string name, int kind, uint security,
        out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern uint SetNamedSecurityInfo(string name, int kind, uint security,
        IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string sddl,
        uint revision, out IntPtr descriptor, out uint size);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool GetSecurityDescriptorSacl(IntPtr descriptor, out bool present,
        out IntPtr sacl, out bool defaulted);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool GetAce(IntPtr acl, int index, out IntPtr ace);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool GetTokenInformation(IntPtr token, int information, IntPtr data,
        int size, out int needed);
    [DllImport("kernel32.dll")]
    static extern IntPtr LocalFree(IntPtr memory);

    static int SidLevel(IntPtr sid) {
        string value = new SecurityIdentifier(sid).Value;
        return Int32.Parse(value.Substring(value.LastIndexOf('-') + 1));
    }

    public static int ProcessLevel() {
        using (WindowsIdentity identity = WindowsIdentity.GetCurrent()) {
            IntPtr token = identity.Token;
            int needed;
            GetTokenInformation(token, 25, IntPtr.Zero, 0, out needed);
            IntPtr data = Marshal.AllocHGlobal(needed);
            try {
                if (!GetTokenInformation(token, 25, data, needed, out needed))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                return SidLevel(Marshal.ReadIntPtr(data));
            } finally { Marshal.FreeHGlobal(data); }
        }
    }

    public static int FileLevel(string file) {
        IntPtr owner, group, dacl, sacl, descriptor;
        uint error = GetNamedSecurityInfo(file, 1, 0x10, out owner, out group,
            out dacl, out sacl, out descriptor);
        if (error != 0) throw new Win32Exception((int)error, file);
        try {
            if (sacl == IntPtr.Zero) return 8192; // No label means Medium.
            int count = (ushort)Marshal.ReadInt16(sacl, 4);
            for (int index = 0; index < count; index++) {
                IntPtr ace;
                if (!GetAce(sacl, index, out ace))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                if (Marshal.ReadByte(ace) == 0x11) // SYSTEM_MANDATORY_LABEL_ACE
                    return SidLevel(IntPtr.Add(ace, 8));
            }
            return 8192;
        } finally { LocalFree(descriptor); }
    }

    public static void SetMedium(string file) {
        IntPtr descriptor;
        uint size;
        if (!ConvertStringSecurityDescriptorToSecurityDescriptor("S:(ML;;NW;;;ME)",
            1, out descriptor, out size))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        try {
            bool present, defaulted;
            IntPtr sacl;
            if (!GetSecurityDescriptorSacl(descriptor, out present, out sacl, out defaulted))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            uint error = SetNamedSecurityInfo(file, 1, 0x10, IntPtr.Zero,
                IntPtr.Zero, IntPtr.Zero, sacl);
            if (error != 0) throw new Win32Exception((int)error, file);
        } finally { LocalFree(descriptor); }
    }
}
'@

$paths = ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())
$processIntegrity = [BlodeRuntimeIntegrity]::ProcessLevel()
$results = @(
    foreach ($file in $paths) {
        $item = Get-Item -LiteralPath $file
        if ($item.PSIsContainer -or $item.Extension -ine '.exe' -or
            ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "Expected a regular runtime executable: $file"
        }
        $before = [BlodeRuntimeIntegrity]::FileLevel($item.FullName)
        $repaired = $false
        if ($before -lt 8192 -and -not $CheckOnly) {
            if ($processIntegrity -lt 8192) {
                throw 'Run npm run repair:permissions from a normal PowerShell window. The current process is Low integrity.'
            }
            [BlodeRuntimeIntegrity]::SetMedium($item.FullName)
            $repaired = $true
        }
        $after = [BlodeRuntimeIntegrity]::FileLevel($item.FullName)
        if ($repaired -and $after -ne 8192) { throw "Could not restore Medium integrity: $file" }
        [pscustomobject]@{ path = $item.FullName; before = $before; after = $after; repaired = $repaired }
    }
)
@{ processIntegrity = $processIntegrity; files = $results } | ConvertTo-Json -Compress -Depth 4
