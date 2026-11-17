<?php
// hooks/appstore-pin.php — called by prep-custom-apps-for-upgrade.sh (x-app.update.prepare).
//
//   php appstore-pin.php <config.php> <state file>
//
// Pins Nextcloud's `appstoreenabled` system config to false before the image entrypoint
// runs `occ upgrade`, so the upgrade can never pull a newer richdocuments (or any other
// app) from the app store, and a hop gives the same result online and offline
// (Axle nc35-engine-review §#456 L, option (a); Steve's decision 2026-11-16).
//
// Why not `occ config:system:set appstoreenabled --value=false --type=boolean` here:
// prepare runs as a one-off with --no-deps (MariaDB is stopped), as root (occ refuses
// to run as a user that does not own config.php), and on a tree whose code is already
// the new major (occ is in "needs upgrade" mode). So this script edits config.php the
// same content Nextcloud's own Config::writeData() writes (var_export of $CONFIG,
// mode 0640, owner and group of the old file), but atomically (temp + rename). work
// (the first stage after verify) restores the previous value with occ once the DB is
// up (update-lib.sh idea_appstore_restore).
//
// Runs only as x-app.update.prepare. Two properties make it unsafe anywhere else:
//  - It include()s config.php and every other config/*.config.php as root, inside the
//    one-off prepare container (not on the host). These are the App's own files.
//  - TERM-safe (engine#456: a step timeout is SIGTERM, then SIGKILL after 10 s). Both
//    writes are atomic: the new content goes to a temp file in the same directory
//    (config/.config.php.idea-tmp-<pid>, <state>.tmp-<pid>), is fsync'd, gets the old
//    file's mode/owner/group, and is rename()d over the target. A kill at any point
//    leaves the old or the new file, never a partial one. A rerun removes stale temp
//    files of both kinds first. (config.php gets a new inode; the bind mount is the
//    whole data/nextcloud dir, so nothing holds the old one.) The Engine still restores
//    the snapshot after any failed or interrupted prepare (gap 6, policy 1).
//    Do not reuse this script outside prepare.
//
// Refusals before anything is written (Axle review of the pin, 2026-11-16):
//  - NEXTCLOUD_CONFIG_DIR set to a different directory (Nextcloud would read another config);
//  - config.php that is not plain literals (token_get_all): code such as
//    getenv('X') ?: 'y' would be evaluated and written back frozen (S5);
//  - config_is_read_only true in config.php or any config/*.config.php: Nextcloud refuses
//    all config writes then, so the restore in work could never succeed (S2);
//  - less free space in config/ than the new content + 10 KB, Nextcloud's own rule (S1).
//
// Order (crash-safe): 1. write the state file (previous value), 2. edit config.php,
// 3. re-read config.php and check the pin. A crash after 1 leaves config.php untouched
// and the state file names its real previous value, so work's restore is a no-op.
//
// State file: first record wins while the pin is in effect. If the file already exists
// and config.php's appstoreenabled is false (a retried prepare, or an earlier hop whose
// restore never ran), the recorded previous value is kept, never overwritten with the
// pinned `false`. If the file exists but appstoreenabled is NOT false (or unset), the pin
// is not in effect, so the file is stale (an admin changed the value by hand, or a partial
// restore): it is logged and rewritten with the current value, then the pin is set (S3).
// A stale file plus a hand-set `false` cannot be told apart; that case keeps the file.
//
// State format (one value line, shell-parsable by update-lib.sh):
//   previous=unset | previous=bool:true | previous=bool:false | previous=int:<n>
//   previous=string:<base64>
// Any other type (array, float, null) is refused: exit 1, prepare fails, hop rolls back.
//
// Also refused (pin would not take effect): appstoreenabled set in another
// config/*.config.php (Nextcloud merges those over config.php) or via env
// NC_appstoreenabled (Nextcloud's env override).
//
// Output: info lines "idea-appstore-pin: ..."; errors START with "ERROR:" (engine#456:
// the Engine matches it only at the start of a line): "ERROR: ... [idea-appstore-pin]".
// Tests only: IDEA_PIN_TEST_DIE_AT=state-tmp|config-tmp exits 137 right after the
// temp file is written and before the rename, like a SIGKILL there.

function out($msg) { fwrite(STDOUT, "idea-appstore-pin: $msg\n"); }
function fail($msg) { fwrite(STDOUT, "ERROR: $msg [idea-appstore-pin]\n"); exit(1); }
function test_die_at($point) {
	if (getenv('IDEA_PIN_TEST_DIE_AT') === $point) {
		exit(137);
	}
}

// Write $content to $path atomically: same-dir temp, fsync, copy mode/owner/group, rename.
function atomic_write($path, $tmp, $content, $mode, $diePoint) {
	$fp = @fopen($tmp, 'x');
	if (!is_resource($fp)) {
		return "cannot create $tmp";
	}
	$ok = fwrite($fp, $content) === strlen($content) && fflush($fp);
	if ($ok && function_exists('fsync')) {
		$ok = fsync($fp);
	}
	fclose($fp);
	if (!$ok) {
		@unlink($tmp);
		return "writing $tmp failed";
	}
	@chmod($tmp, $mode);
	if (file_exists($path)) {
		$uid = @fileowner($path);
		$gid = @filegroup($path);
		if ($uid !== false && $uid !== @fileowner($tmp)) {
			@chown($tmp, $uid);
		}
		if ($gid !== false && $gid !== @filegroup($tmp)) {
			@chgrp($tmp, $gid);
		}
	}
	test_die_at($diePoint);
	if (!@rename($tmp, $path)) {
		@unlink($tmp);
		return "rename $tmp -> $path failed";
	}
	return null;
}

function read_config($path) {
	$CONFIG = null;
	// Isolated scope: config.php only defines $CONFIG.
	if (!(include $path)) {
		return null;
	}
	return is_array($CONFIG) ? $CONFIG : null;
}

// S5: config.php must be plain data: $CONFIG = array(...) / [...] (and optional
// $CONFIG['k'] = literal; lines), literals, true/false/null, comments, whitespace.
function plain_literals_only($path) {
	$code = @file_get_contents($path);
	if ($code === false) {
		return 'cannot read file';
	}
	$allowedTok = [T_OPEN_TAG, T_CLOSE_TAG, T_WHITESPACE, T_COMMENT, T_DOC_COMMENT, T_ARRAY,
		T_CONSTANT_ENCAPSED_STRING, T_LNUMBER, T_DNUMBER, T_DOUBLE_ARROW];
	$allowedChar = ['=', '(', ')', '[', ']', ',', ';', '-', '+'];
	foreach (token_get_all($code) as $t) {
		if (is_string($t)) {
			if (!in_array($t, $allowedChar, true)) {
				return "unexpected '$t'";
			}
			continue;
		}
		[$id, $text] = $t;
		if (in_array($id, $allowedTok, true)) {
			continue;
		}
		if ($id === T_VARIABLE && $text === '$CONFIG') {
			continue;
		}
		if ($id === T_STRING && in_array(strtolower($text), ['true', 'false', 'null'], true)) {
			continue;
		}
		return token_name($id) . ' ' . trim(substr($text, 0, 40));
	}
	return null;
}

function encode_previous($exists, $value) {
	if (!$exists) {
		return 'unset';
	}
	if (is_bool($value)) {
		return 'bool:' . ($value ? 'true' : 'false');
	}
	if (is_int($value)) {
		return 'int:' . $value;
	}
	if (is_string($value)) {
		return 'string:' . base64_encode($value);
	}
	return null;
}

if ($argc !== 3) {
	fail('usage: appstore-pin.php <config.php> <state file>');
}
$configPath = $argv[1];
$statePath = $argv[2];
$key = 'appstoreenabled';

if (getenv('NC_' . $key) !== false) {
	fail("NC_$key is set in the environment; it overrides config.php, so the app store pin cannot take effect");
}
if (!is_file($configPath)) {
	fail("config.php missing: $configPath");
}
$ncDir = getenv('NEXTCLOUD_CONFIG_DIR');
if ($ncDir !== false && $ncDir !== '') {
	$a = realpath($ncDir);
	$b = realpath(dirname($configPath));
	if ($a === false || $a !== $b) {
		fail("NEXTCLOUD_CONFIG_DIR=$ncDir is not the directory of $configPath; refusing to pin a config Nextcloud would not read");
	}
}
$why = plain_literals_only($configPath);
if ($why !== null) {
	fail("config.php is not plain literals ($why); refusing to rewrite it (code would be written back frozen)");
}
$config = read_config($configPath);
if ($config === null) {
	fail("cannot read \$CONFIG from $configPath");
}
if (!isset($config['version'])) {
	// Same guard as Nextcloud's Config::writeData(): never overwrite a config.php
	// that was not read correctly.
	fail("$configPath has no 'version'; refusing to rewrite it");
}

// Nextcloud merges every other config/*.config.php over config.php.
$configDir = dirname($configPath);
// The official image's config/apps.config.php uses OC::$SERVERROOT (and could use other
// Nextcloud code). Outside Nextcloud that class does not exist, so an include was a fatal
// "Class OC not found" (php exit 255; seen on idea03, engine#456 chain rehearsal). Provide
// the one static Nextcloud defines before it reads config (server root = parent of config/),
// and turn any other error in an extra file into a clean refusal.
if (!class_exists('OC', false)) {
	eval('class OC { public static $SERVERROOT = ""; }');
	OC::$SERVERROOT = dirname($configDir);
}
foreach (glob($configDir . '/*.config.php') ?: [] as $extra) {
	if (realpath($extra) === realpath($configPath)) {
		continue;
	}
	try {
		$extraConfig = read_config($extra);
	} catch (\Throwable $e) {
		fail('cannot read ' . basename($extra) . ' (' . get_class($e) . ': ' . $e->getMessage() . '); refusing to pin');
	}
	if (is_array($extraConfig) && array_key_exists($key, $extraConfig)) {
		fail(basename($extra) . " sets $key; it overrides config.php, so the app store pin cannot take effect");
	}
	if (is_array($extraConfig) && !empty($extraConfig['config_is_read_only'])) {
		fail(basename($extra) . " sets config_is_read_only; Nextcloud would refuse the restore, so the pin is refused");
	}
}
if (!empty($config['config_is_read_only'])) {
	fail("config_is_read_only is set in config.php; Nextcloud would refuse the restore, so the pin is refused");
}

// Stale temp files from an interrupted (killed) earlier run.
foreach (array_merge(glob($configDir . '/.config.php.idea-tmp-*') ?: [], glob($statePath . '.tmp-*') ?: []) as $stale) {
	if (@unlink($stale)) {
		out("removed stale temp file " . basename($stale) . " from an interrupted run");
	} else {
		fail("cannot remove stale temp file $stale");
	}
}

$exists = array_key_exists($key, $config);
$previous = encode_previous($exists, $exists ? $config[$key] : null);
if ($previous === null) {
	fail("$key has an unsupported type (" . gettype($config[$key]) . ") in config.php; refusing to pin it");
}

// 1. State file (first record wins).
$pinInEffect = $exists && $config[$key] === false;
if (file_exists($statePath) && !$pinInEffect) {
	out("state file $statePath is stale ($key is " . ($exists ? var_export($config[$key], true) : 'unset') . ", not the pinned false); recording the current value again");
	if (!@unlink($statePath)) {
		fail("cannot remove stale state file $statePath");
	}
}
if (file_exists($statePath)) {
	$kept = null;
	foreach (file($statePath, FILE_IGNORE_NEW_LINES) ?: [] as $line) {
		if (strncmp($line, 'previous=', 9) === 0) {
			$kept = substr($line, 9);
			break;
		}
	}
	if ($kept === null || $kept === '') {
		fail("state file $statePath exists but has no previous= line; refusing to guess");
	}
	out("state file already records previous=$kept (kept, first record wins)");
} else {
	$tmp = $statePath . '.tmp-' . getmypid();
	$body = "# IDEA app store pin, written by x-app.update.prepare (hooks/appstore-pin.php).\n"
		. "# work (hooks/work-update.sh) restores this value with occ and then removes this file.\n"
		. "previous=$previous\n";
	$err = atomic_write($statePath, $tmp, $body, 0644, 'state-tmp');
	if ($err !== null) {
		fail("cannot write state file $statePath ($err)");
	}
	out("recorded previous=$previous in $statePath");
}

// 2. config.php (skip the write when it is already pinned: idempotent).
if ($exists && $config[$key] === false) {
	out("$key already false in config.php (no write)");
} else {
	$config[$key] = false;
	$content = "<?php\n\$CONFIG = " . var_export($config, true) . ";\n";
	// S1: Nextcloud's writeData() rule: never truncate without room for the new content.
	// IDEA_PIN_TEST_DISK_FREE (bytes) stands in for disk_free_space() in tests only.
	$fake = getenv('IDEA_PIN_TEST_DISK_FREE');
	$df = ($fake !== false && $fake !== '') ? (float)$fake : @disk_free_space(dirname($configPath));
	if ($df !== false && $df < (float)(strlen($content) + 10240)) {
		fail(dirname($configPath) . " does not have enough free space for config.php (need " . (strlen($content) + 10240) . " bytes, have " . (int)$df . "); not writing");
	}
	// Nextcloud refuses to write a config.php that is not writable; so do we (the
	// rename below would otherwise replace a read-only file).
	if (!is_writable($configPath)) {
		fail("$configPath is not writable; not writing");
	}
	$err = atomic_write($configPath, $configDir . '/.config.php.idea-tmp-' . getmypid(), $content, 0640, 'config-tmp');
	if ($err !== null) {
		fail("writing $configPath failed ($err)");
	}
	out("set $key=false in config.php");
}

// 3. Check.
clearstatcache();
$check = read_config($configPath);
if ($check === null || !array_key_exists($key, $check) || $check[$key] !== false || !isset($check['version'])) {
	fail("config.php does not read back with $key=false");
}
out("pinned $key=false");
exit(0);
