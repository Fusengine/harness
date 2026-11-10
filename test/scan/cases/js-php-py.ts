/**
 * Positive/negative snippets per rule id (JS/TS, PHP, Python). Each case is
 * `[positive, negative]`: the rule regex must match the first and not the second.
 */
import { FAKE_AWS, kv } from "../builders";

/** `[positive, negative]` snippet pair. */
export type Case = readonly [positive: string, negative: string];
/** Cases keyed by rule id. */
export type Cases = Record<string, Case>;

const BT = "\x60";

export const JS_PHP_PY_CASES: Cases = {
  "js.xss.innerhtml-assign": ["el.innerHTML = x", "el.textContent = x"],
  "js.xss.dangerously-set": ["<div dangerouslySetInnerHTML={h}/>", '<div className="a"/>'],
  "js.exec.eval": ["eval(code)", "evaluate(code)"],
  "js.exec.new-function": ["new Function(b)", "new FunctionX(b)"],
  "js.cmd.child-process": ["require('child_process')", "require('node:fs')"],
  "js.cmd.shell-true": ["spawn(c, { shell: true })", "spawn(c, { shell: false })"],
  "js.crypto.math-random": ["const r = Math.random()", "const r = Math.floor(x)"],
  "js.secret.akia": [`const k = "${FAKE_AWS}"`, 'const k = "AKIA1234"'],
  "js.exec.eval-dynamic": ["eval(userInput)", 'eval("1+1")'],
  "js.exec.new-function-dynamic": ["new Function(body)", 'new Function("return 1")'],
  "js.cmd.spawn-shell": ["spawn(c, a, { shell: true })", "spawn(c, a, { shell: false })"],
  "js.xss.react-dsih": ["<div dangerouslySetInnerHTML={{ __html: html }} />", '<div dangerouslySetInnerHTML={{ __html: "<b>x</b>" }} />'],
  "php.exec.eval-dynamic": ["eval($code);", 'eval("return 1;")'],
  "py.exec.eval-dynamic": ["exec(code)", "model.eval()"],
  "py.cmd.subprocess-shell": ["subprocess.run(cmd, shell=True)", 'subprocess.run(["ls"], shell=False)'],
  "js.exec.timer-string": ['setTimeout("tick()", 100)', "setTimeout(() => tick(), 100)"],
  "js.exec.vm-run": ["vm.runInNewContext(code, sb)", 'vm.runInNewContext("1+1")'],
  "js.cmd.exec-interp": [`exec(${BT}ls \${dir}${BT})`, 'exec("ls -la")'],
  "js.xss.innerhtml-dynamic": ["el.innerHTML = userHtml", 'el.innerHTML = ""'],
  "js.xss.document-write": ["document.write(html)", 'document.write("<p>")'],
  "js.xss.framework-html": ['<div v-html="body"></div>', '<div v-bind:title="t"></div>'],
  "js.sql.concat": ['db.query("SELECT * FROM u WHERE id = " + id)', 'db.query("SELECT * FROM u WHERE id = $1", [id])'],
  "js.deser.node-serialize": ["serialize.unserialize(req.body.d)", "JSON.parse(data)"],
  "js.crypto.weak-hash": ["crypto.createHash('md5').update(pw)", "crypto.createHash('sha256')"],
  "js.crypto.create-cipher": ['crypto.createCipher("aes192", pw)', 'crypto.createCipheriv("aes-256-gcm", k, iv)'],
  "js.crypto.weak-cipher": ['createCipheriv("aes-128-ecb", k, null)', 'createCipheriv("aes-256-gcm", k, iv)'],
  "js.crypto.math-random-secret": ["const sessionToken = Math.random().toString(36)", "const jitter = Math.random() * 100"],
  "js.tls.disabled": ["https.request({ rejectUnauthorized: false })", "https.request({ rejectUnauthorized: true })"],
  "php.cmd.shell-exec-system": ["shell_exec($c);", 'echo "hi";'],
  "php.exec.eval-assert": ["eval($c);", "echo 1;"],
  "php.sql.mysql-query": ["mysql_query($q);", "mysqli_ping($c);"],
  "php.cmd.exec-family": ["shell_exec($cmd);", "$db->exec($sql);"],
  "php.cmd.backtick": [`$out = ${BT}ls $dir${BT};`, `$out = ${BT}ls -la${BT};`],
  "php.deser.unserialize": ["unserialize($_COOKIE['d']);", "json_decode($x);"],
  "php.sql.concat": ['$pdo->query("SELECT * FROM u WHERE id=" . $id);', '$pdo->query("SELECT 1");'],
  "php.include.user": ["include $_GET['page'] . '.php';", "include 'header.php';"],
  "php.crypto.md5-password": ["md5($password)", "md5($file)"],
  "php.crypto.rand-secret": ["$token = md5(uniqid(rand()));", "$token = bin2hex(random_bytes(16));"],
  "py.exec.eval-exec": ["eval(x)", "print(x)"],
  "py.cmd.os-system-shell": ["os.system(c)", "os.getcwd()"],
  "py.deser.pickle-loads": ["pickle.loads(d)", "json.loads(d)"],
  "py.tls.verify-false": ["requests.get(u, verify=False)", "requests.get(u, verify=True)"],
  "py.deser.pickle-family": ["pickle.load(f)", "pickle.dumps(o)"],
  "py.deser.yaml-load": ["yaml.load(f)", "yaml.load(f, Loader=yaml.SafeLoader)"],
  "py.cmd.os-system": ["os.popen(cmd)", 'os.system("clear")'],
  "py.tls.disabled": ["ctx.check_hostname = False", "requests.get(u, verify=True)"],
  "py.crypto.weak-hash": ["hashlib.md5(pw.encode())", "hashlib.sha256(pw)"],
  "py.sql.format": ['cur.execute(f"SELECT * FROM u WHERE id={uid}")', 'cur.execute("SELECT * FROM u WHERE id=%s", (uid,))'],
  "py.crypto.random-secret": [kv("tok" + "en", "''.join(random.choice(chars) for _ in range(32))"), kv("tok" + "en", "secrets.token_hex(16)")],
};
