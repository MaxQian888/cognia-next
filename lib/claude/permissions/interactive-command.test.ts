import { detectInteractiveCommand } from "./interactive-command"

/** Helper: assert interactive + optional head. */
function expectInteractive(cmd: string, head?: string) {
  const r = detectInteractiveCommand(cmd)
  expect(r.interactive).toBe(true)
  if (head) expect(r.head).toBe(head)
  expect(r.reason).toBeTruthy()
}

function expectNonInteractive(cmd: string) {
  const r = detectInteractiveCommand(cmd)
  expect(r.interactive).toBe(false)
}

describe("detectInteractiveCommand", () => {
  describe("editors", () => {
    it.each(["vi", "vim file.txt", "nvim", "nano notes", "emacs", "pico", "ed", "micro x"])(
      "flags %s",
      (cmd) => expectInteractive(cmd)
    )
    it("returns the editor head", () => expectInteractive("vim a.txt", "vim"))
  })

  describe("pagers / full-screen", () => {
    it.each(["top", "htop", "less file", "more file", "man git"])("flags %s", (cmd) =>
      expectInteractive(cmd)
    )
  })

  describe("REPLs", () => {
    it.each([
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
    ])("flags bare %s", (cmd) => expectInteractive(cmd))
    it("flags a REPL with only non-action flags", () => expectInteractive("python -u"))
    it("does NOT flag a script invocation", () => expectNonInteractive("python app.py"))
    it("does NOT flag -c/-e/--eval", () => {
      expectNonInteractive('python -c "print(1)"')
      expectNonInteractive('node -e "console.log(1)"')
      expectNonInteractive('ruby --eval "puts 1"')
    })
    it("does NOT flag -m module", () => expectNonInteractive("python -m http.server"))
    it("does NOT flag --version / --help", () => {
      expectNonInteractive("node --version")
      expectNonInteractive("python --help")
    })
  })

  describe("database clients", () => {
    it.each([
      "psql mydb",
      "mysql -h localhost mydb",
      "mongosh",
      "mongo",
      "sqlite3 db.sqlite",
      "redis-cli",
    ])("flags interactive %s", (cmd) => expectInteractive(cmd))
    it("does NOT flag -c/-e/--command", () => {
      expectNonInteractive('psql -c "SELECT 1"')
      expectNonInteractive('mysql -e "SELECT 1"')
      expectNonInteractive('mongosh --eval "db.stats()"')
    })
    it("does NOT flag inline SQL positional", () => {
      expectNonInteractive('sqlite3 db.sqlite "SELECT 1"')
      expectNonInteractive("redis-cli GET foo")
    })
  })

  describe("login / auth flows", () => {
    it.each([
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
    ])("flags %s", (cmd) => expectInteractive(cmd))
    it("does NOT flag with --token / --password-stdin", () => {
      expectNonInteractive("npm login --token abc")
      expectNonInteractive("docker login --password-stdin")
      expectNonInteractive("az login --service-principal")
    })
    it("does NOT flag aws configure subcommands", () => {
      expectNonInteractive("aws configure set region us-east-1")
      expectNonInteractive("aws configure list")
    })
    it("does NOT flag unrelated subcommands", () => {
      expectNonInteractive("npm install")
      expectNonInteractive("gh pr view 3")
      expectNonInteractive("docker ps")
    })
  })

  describe("git interactive subcommands", () => {
    it("flags rebase -i", () => expectInteractive("git rebase -i main", "git"))
    it("flags add -p / -i", () => {
      expectInteractive("git add -p")
      expectInteractive("git add --interactive")
    })
    it("flags config --edit", () => expectInteractive("git config --edit"))
    it("flags a message-less commit", () => expectInteractive("git commit"))
    it("does NOT flag rebase without -i", () => expectNonInteractive("git rebase main"))
    it("does NOT flag commit with -m / -am / --message / --no-edit", () => {
      expectNonInteractive('git commit -m "msg"')
      expectNonInteractive('git commit -am "msg"')
      expectNonInteractive('git commit --message="msg"')
      expectNonInteractive("git commit --amend --no-edit")
    })
    it("does NOT flag plain git subcommands", () => {
      expectNonInteractive("git status")
      expectNonInteractive("git add .")
      expectNonInteractive("git log")
    })
  })

  describe("remote shells", () => {
    it("flags ssh to a bare host", () => expectInteractive("ssh example.com", "ssh"))
    it("flags ssh with a value flag before the host", () => expectInteractive("ssh -p 22 host"))
    it("flags ssh with an attached-value flag", () => expectInteractive("ssh -p22 host"))
    it("flags ssh with a boolean flag", () => expectInteractive("ssh -4 host"))
    it("does NOT flag ssh host <command>", () => expectNonInteractive("ssh host ls -la"))
    it("flags sftp / telnet / ftp to a host", () => {
      expectInteractive("sftp host")
      expectInteractive("telnet host 23")
      expectInteractive("ftp host")
    })
  })

  describe("password / passphrase prompts", () => {
    it.each(["passwd", "passwd user", "su", "ssh-keygen", "ssh-add", "gpg --gen-key"])(
      "flags %s",
      (cmd) => expectInteractive(cmd)
    )
    it("does NOT flag ssh-keygen with -N", () =>
      expectNonInteractive('ssh-keygen -t ed25519 -f key -N ""'))
    it("does NOT flag ssh-add query flags", () => {
      expectNonInteractive("ssh-add -l")
      expectNonInteractive("ssh-add -D")
    })
    it("does NOT flag non-generating gpg", () => expectNonInteractive("gpg --decrypt file.gpg"))
  })

  describe("container -it", () => {
    it("flags docker run -it", () => expectInteractive("docker run -it ubuntu bash", "docker"))
    it("flags -ti and long forms", () => {
      expectInteractive("docker exec -ti web sh")
      expectInteractive("podman run --interactive --tty alpine")
      expectInteractive("kubectl exec -it pod -- sh")
    })
    it("does NOT flag detached run", () => expectNonInteractive("docker run -d nginx"))
    it("does NOT flag docker ps / build", () => {
      expectNonInteractive("docker ps")
      expectNonInteractive("docker build .")
    })
  })

  describe("wrapper unwrapping", () => {
    it("peels timeout + duration", () => expectInteractive("timeout 10 vim file", "vim"))
    it("peels sudo", () => expectInteractive("sudo vim /etc/hosts", "vim"))
    it("peels nested wrappers", () => expectInteractive("sudo nohup psql mydb", "psql"))
    it("peels env NAME=value", () => expectInteractive("env FOO=bar python", "python"))
    it("does NOT over-flag a wrapped normal command", () =>
      expectNonInteractive("sudo apt-get update"))
    it("does NOT flag a wrapper with no inner command", () => expectNonInteractive("sudo -k"))
  })

  describe("compound commands", () => {
    it("flags when any segment is interactive", () => {
      expectInteractive("echo hi && vim")
      expectInteractive("git pull; git rebase -i")
      expectInteractive("cat log | less")
    })
    it("flags an interactive command hidden in a subshell", () => expectInteractive("echo $(vim)"))
    it("does NOT flag an all-safe pipeline", () => {
      expectNonInteractive("ls && echo done")
      expectNonInteractive("cat a.txt | grep foo | wc -l")
    })
  })

  describe("fallbacks", () => {
    it("returns non-interactive for unknown commands", () => {
      expectNonInteractive("ls -la")
      expectNonInteractive("npm run build")
      expectNonInteractive("echo hello")
    })
    it("returns non-interactive for an empty command", () => expectNonInteractive("   "))
    it("carries a reason on the negative result", () => {
      const r = detectInteractiveCommand("ls")
      expect(r.interactive).toBe(false)
      expect(r.reason).toBe("no interactive command detected")
    })
  })
})
