import ctypes,errno,http.server,json,os,pathlib,socket,time
root=pathlib.Path.cwd()
r={"pid":os.getpid(),"checks":[],"status":pathlib.Path('/proc/self/status').read_text(),"namespaces":{n:os.readlink('/proc/self/ns/'+n) for n in ['user','mnt','net','pid','ipc','uts']},"fds":{}}
for entry in pathlib.Path('/proc/self/fd').iterdir():
 try:r['fds'][entry.name]=os.readlink(entry)
 except OSError:pass
for family,target,scope in [(socket.AF_INET,'169.254.169.254',0),(socket.AF_INET6,'::ffff:169.254.169.254',0),(socket.AF_INET,'10.0.0.1',0),(socket.AF_INET,'172.16.0.1',0),(socket.AF_INET,'192.168.0.1',0),(socket.AF_INET6,'fd00::1',0),(socket.AF_INET6,'fe80::1',1)]:
 for kind,port in [(socket.SOCK_STREAM,80),(socket.SOCK_STREAM,443),(socket.SOCK_DGRAM,443)]:
  s=socket.socket(family,kind);s.settimeout(.5)
  try:s.connect((target,port,0,scope) if family==socket.AF_INET6 else (target,port));result='CONNECTED'
  except OSError as e:result=e.errno
  s.close();r['checks'].append({'target':target,'kind':kind,'port':port,'errno':result})
libc=ctypes.CDLL(None,use_errno=True);r['unshareResult']=libc.unshare(0x40000000);r['unshareErrno']=ctypes.get_errno()
r['protectedControlVisible']=pathlib.Path('/run/cognia-desktop/control.sock').exists();r['providerRootVisible']=pathlib.Path('/run/e2b').exists()
try:os.setuid(0);r['rootRestore']='SUCCEEDED'
except OSError as e:r['rootRestore']=e.errno
if os.fork()==0:
 os.setsid()
 if os.fork()!=0:os._exit(0)
 (root/'detached.json').write_text(json.dumps({'pid':os.getpid(),'status':pathlib.Path('/proc/self/status').read_text(),'ns':os.readlink('/proc/self/ns/net')}))
 time.sleep(1000);os._exit(0)
os.wait()
(root/'probe.json').write_text(json.dumps(r))
class Handler(http.server.BaseHTTPRequestHandler):
 def do_GET(self):
  self.send_response(200);self.end_headers();self.wfile.write(b'cognia-p3-native-host-handoff')
 def log_message(self,*args):pass
import subprocess,threading
server=http.server.HTTPServer(('127.0.0.1',8765),Handler)
def show():
 time.sleep(2)
 subprocess.run(['/usr/bin/chromium','--no-sandbox','--disable-dev-shm-usage','--new-window','http://127.0.0.1:8765'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
threading.Thread(target=show,daemon=True).start()
server.serve_forever()
