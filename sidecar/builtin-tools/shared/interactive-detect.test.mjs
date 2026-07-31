import { test } from "node:test"
import assert from "node:assert/strict"

import { detectInteractiveCommand } from "./interactive-detect.mjs"

function interactive(cmd, head) {
  const r = detectInteractiveCommand(cmd)
  assert.equal(r.interactive, true, `expected interactive: ${cmd}`)
  if (head) assert.equal(r.head, head, `expected head ${head} for: ${cmd}`)
  assert.ok(r.reason, `expected a reason for: ${cmd}`)
}

function nonInteractive(cmd) {
  const r = detectInteractiveCommand(cmd)
  assert.equal(r.interactive, false, `expected non-interactive: ${cmd}`)
}

test("editors are interactive", () => {
  for (const cmd of [
    "vi",
    "vim file.txt",
    "nvim",
    "nano notes",
    "emacs",
    "pico",
    "ed",
    "micro x",
  ]) {
    interactive(cmd)
  }
  interactive("vim a.txt", "vim")
})

test("pagers / full-screen are interactive", () => {
  for (const cmd of ["top", "htop", "less file", "more file", "man git"]) interactive(cmd)
})

test("bare REPLs are interactive; scripts / eval / info flags are not", () => {
  for (const cmd of [
    "python",
    "python3",
    "node",
    "irb",
    "ruby",
    "php",
    "lua",
    "deno",
    "bun",
    "R",
    "iex",
    "ghci",
  ]) {
    interactive(cmd)
  }
  interactive("python -u")
  nonInteractive("python app.py")
  nonInteractive('python -c "print(1)"')
  nonInteractive('node -e "console.log(1)"')
  nonInteractive("python -m http.server")
  nonInteractive("node --version")
  nonInteractive("python --help")
})

test("database clients", () => {
  for (const cmd of [
    "psql mydb",
    "mysql -h localhost mydb",
    "mongosh",
    "mongo",
    "sqlite3 db.sqlite",
    "redis-cli",
  ]) {
    interactive(cmd)
  }
  nonInteractive('psql -c "SELECT 1"')
  nonInteractive('mysql -e "SELECT 1"')
  nonInteractive('mongosh --eval "db.stats()"')
  nonInteractive('sqlite3 db.sqlite "SELECT 1"')
  nonInteractive("redis-cli GET foo")
})

test("login / auth flows", () => {
  for (const cmd of [
    "npm login",
    "pnpm login",
    "yarn adduser",
    "gh auth login",
    "docker login",
    "aws configure",
    "gcloud auth login",
    "heroku login",
    "vercel login",
    "az login",
    "firebase login",
    "netlify login",
  ]) {
    interactive(cmd)
  }
  nonInteractive("npm login --token abc")
  nonInteractive("docker login --password-stdin")
  nonInteractive("az login --service-principal")
  nonInteractive("aws configure set region us-east-1")
  nonInteractive("aws configure list")
  nonInteractive("npm install")
  nonInteractive("gh pr view 3")
  nonInteractive("docker ps")
})

test("git interactive subcommands", () => {
  interactive("git rebase -i main", "git")
  interactive("git add -p")
  interactive("git add --interactive")
  interactive("git config --edit")
  interactive("git commit")
  nonInteractive("git rebase main")
  nonInteractive('git commit -m "msg"')
  nonInteractive('git commit -am "msg"')
  nonInteractive('git commit --message="msg"')
  nonInteractive("git commit --amend --no-edit")
  nonInteractive("git status")
  nonInteractive("git add .")
  nonInteractive("git log")
})

test("remote shells", () => {
  interactive("ssh example.com", "ssh")
  interactive("ssh -p 22 host")
  interactive("ssh -p22 host")
  interactive("ssh -4 host")
  nonInteractive("ssh host ls -la")
  interactive("sftp host")
  interactive("telnet host 23")
  interactive("ftp host")
})

test("password / passphrase prompts", () => {
  for (const cmd of ["passwd", "passwd user", "su", "ssh-keygen", "ssh-add", "gpg --gen-key"]) {
    interactive(cmd)
  }
  nonInteractive('ssh-keygen -t ed25519 -f key -N ""')
  nonInteractive("ssh-add -l")
  nonInteractive("ssh-add -D")
  nonInteractive("gpg --decrypt file.gpg")
})

test("container -it", () => {
  interactive("docker run -it ubuntu bash", "docker")
  interactive("docker exec -ti web sh")
  interactive("podman run --interactive --tty alpine")
  interactive("kubectl exec -it pod -- sh")
  nonInteractive("docker run -d nginx")
  nonInteractive("docker ps")
  nonInteractive("docker build .")
})

test("wrapper unwrapping", () => {
  interactive("timeout 10 vim file", "vim")
  interactive("sudo vim /etc/hosts", "vim")
  interactive("sudo nohup psql mydb", "psql")
  interactive("env FOO=bar python", "python")
  nonInteractive("sudo apt-get update")
  nonInteractive("sudo -k")
})

test("compound commands", () => {
  interactive("echo hi && vim")
  interactive("git pull; git rebase -i")
  interactive("cat log | less")
  interactive("echo $(vim)")
  nonInteractive("ls && echo done")
  nonInteractive("cat a.txt | grep foo | wc -l")
})

test("fallbacks", () => {
  nonInteractive("ls -la")
  nonInteractive("npm run build")
  nonInteractive("echo hello")
  nonInteractive("   ")
  const r = detectInteractiveCommand("ls")
  assert.equal(r.interactive, false)
  assert.equal(r.reason, "no interactive command detected")
})
