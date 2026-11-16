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
// same way Nextcloud's own Config::writeData() does (var_export of $CONFIG, in-place
// write under flock, mode 0640), which keeps the owner (33) and the inode. work
// (the first stage after verify) restores the previous value with occ once the DB is
// up (update-lib.sh idea_appstore_restore).
//
// Runs only as x-app.update.prepare. Two properties make it unsafe anywhere else:
//  - It include()s config.php and every other config/*.config.php as root, inside the
//    one-off prepare container (not on the host). These are the App's own files.
//  - The config.php write is NOT atomic: like Nextcloud's writeData() it truncates and
//    rewrites in place. A crash or a full disk between the two leaves an empty or partial
//    config.php. That is acceptable only because the Engine restores the pre-update
//    snapshot after any failed or interrupted prepare (Axle addendum gap 6, policy 1).
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
// Output: lines prefixed "idea-appstore-pin:"; errors as "idea-appstore-pin: ERROR: ...".

function out($msg) { fwrite(STDOUT, "idea-appstore-pin: $msg\n"); }
function fail($msg) { out("ERROR: $msg"); exit(1); }

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
foreach (glob($configDir . '/*.config.php') ?: [] as $extra) {
	if (realpath($extra) === realpath($configPath)) {
		continue;
	}
	$extraConfig = read_config($extra);
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
	if (@file_put_contents($tmp, $body) === false || !@rename($tmp, $statePath)) {
		@unlink($tmp);
		fail("cannot write state file $statePath");
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
	$fp = @fopen($configPath, 'r+');
	if (!is_resource($fp)) {
		fail("cannot open $configPath for writing");
	}
	if (!flock($fp, LOCK_EX)) {
		fclose($fp);
		fail("cannot lock $configPath");
	}
	$ok = ftruncate($fp, 0) && fwrite($fp, $content) === strlen($content) && fflush($fp);
	if ($ok && function_exists('fsync')) {
		$ok = fsync($fp);
	}
	flock($fp, LOCK_UN);
	fclose($fp);
	if (!$ok) {
		fail("writing $configPath failed");
	}
	@chmod($configPath, 0640);
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
