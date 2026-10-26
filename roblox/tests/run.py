# Builds one Luau file: prelude + TLSAnalytics wrapped as MODULE() + scenario, and runs it.
import subprocess, sys, time, os
here = os.path.dirname(os.path.abspath(__file__))
luau = sys.argv[1]
mod = open(os.path.join(here, "..", "ServerScriptService", "TLSAnalytics", "init.luau")).read()
src = ("BASE_MS = %d\nSECRET = %r\n" % (int(time.time() * 1000), os.environ.get("TLS_INGEST_KEY", "tls_test"))).replace("'", '"')
src += open(os.path.join(here, "harness_prelude.luau")).read()
src += "\nfunction MODULE()\nlocal require = function(x) return x.__module end\n" + mod + "\nend\n"
src += open(os.path.join(here, "harness_scenario.luau")).read()
path = os.path.join(os.environ.get("TMPDIR", "/tmp"), "tls_harness.luau")
open(path, "w").write(src)
r = subprocess.run([luau, path], capture_output=True, text=True)
sys.stdout.write(r.stdout)
sys.stderr.write(r.stderr)
sys.exit(r.returncode)
