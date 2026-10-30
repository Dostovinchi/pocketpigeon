Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = base & "\server"
sh.Run "cmd /c node server.js >> relay.log 2>&1", 0, False
