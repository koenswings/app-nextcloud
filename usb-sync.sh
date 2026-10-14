#!/bin/sh
# usb-sync.sh — reconcile Nextcloud Local external storages with mounted USB sticks
# (idea#193, proposals/2026-10-14-teacher-usb-sticks.md §4).
#
# Called by the Engine as `docker exec -u www-data <nextcloud-app> /idea/usb-sync.sh`
# once at start and after every plug and unplug. The Engine binds host
# /run/idea-usb → /mnt/idea-usb (read-only, rslave), so each stick appears as
# /mnt/idea-usb/<dev> (e.g. sdb1) without recreating the container.
#
# For each stick folder it creates a Local storage "USB: <label>" with
# readonly=true, filesystem_check_changes=1, enable_sharing=false and the own
# marker idea_usb=1, visible to the teachers group + admin only. It deletes
# only idea_usb=1 storages whose folder is gone (config only, never files).
# Admin-created storages are never touched, even under /mnt/idea-usb.
#
# Display names: Engine-written read-only JSON <root>/.idea-usb.json. Accepted
# shapes: [{device, displayName, label}], {sticks:[...]}, or {"sdb1":"USB: X"}.
# Missing → "USB: <dev>".
#
# Env (tests may override):
#   IDEA_USB_ROOT        default /mnt/idea-usb
#   IDEA_USB_JSON        default .idea-usb.json
#   OCC                  occ-compatible binary (default: php /var/www/html/occ)
#   IDEA_TEACHERS_GROUP  default teachers (created when missing)
#   IDEA_OCC_WAIT / IDEA_OCC_INTERVAL  occ readiness wait (default 120 / 3 s)
#   IDEA_USB_LOCK        lock dir (default /tmp/idea-usb-sync.lock)
#
# Fail open: always exits 0; nothing is deleted when occ is not usable.
set -u
set -f   # never glob-expand names (labels, admin entries)

ROOT="${IDEA_USB_ROOT:-/mnt/idea-usb}"; ROOT="${ROOT%/}"
JSON_PATH="$ROOT/${IDEA_USB_JSON:-.idea-usb.json}"
LOCK="${IDEA_USB_LOCK:-/tmp/idea-usb-sync.lock}"
log() { echo "idea-usb: $*"; }

run_occ() {
	if [ -n "${OCC:-}" ]; then "$OCC" "$@"; else php /var/www/html/occ "$@"; fi
}

# js/php helper: $1 = mode (list|name), stdin or args.
helper() {
	mode="$1"; shift
	if command -v node >/dev/null 2>&1; then
		node -e '
const fs=require("fs");const [mode,...a]=process.argv.slice(1);
const t=v=>v===true||v===1||v==="1"||v==="true";
if(mode==="list"){let j;try{j=JSON.parse(fs.readFileSync(0,"utf8")||"[]")}catch{process.exit(0)}
 if(!Array.isArray(j))process.exit(0);
 for(const m of j){const o=m.options||{},c=m.configuration||{};
  console.log([m.mount_id??m.id??"",String(m.mount_point||"").replace(/^\//,""),c.datadir||"",t(o.idea_usb)?1:0,t(o.readonly)?1:0,t(o.enable_sharing)?1:0,(Array.isArray(m.applicable_groups)?m.applicable_groups:[]).join(",")].join("|"))}}
else{let j;try{j=JSON.parse(fs.readFileSync(a[0],"utf8"))}catch{process.exit(0)}
 const dev=a[1];let arr=Array.isArray(j)?j:(j&&Array.isArray(j.sticks)?j.sticks:null);let n="";
 if(arr){const s=arr.find(x=>x&&x.device===dev);if(s)n=s.displayName||s.label||""}
 else if(j&&typeof j==="object"){const v=j[dev];n=typeof v==="string"?v:(v&&(v.displayName||v.label))||""}
 process.stdout.write(String(n))}
' "$mode" "$@"
	else
		php -r '
$a=array_slice($argv,1);$mode=array_shift($a);
$t=function($v){return $v===true||$v===1||$v==="1"||$v==="true";};
if($mode==="list"){$j=json_decode(stream_get_contents(STDIN),true);if(!is_array($j))exit(0);
 foreach($j as $m){$o=$m["options"]??[];$c=$m["configuration"]??[];
  echo implode("|",[$m["mount_id"]??$m["id"]??"",ltrim((string)($m["mount_point"]??""),"/"),$c["datadir"]??"",$t($o["idea_usb"]??null)?1:0,$t($o["readonly"]??null)?1:0,$t($o["enable_sharing"]??null)?1:0,implode(",",is_array($m["applicable_groups"]??null)?$m["applicable_groups"]:[])]),"\n";}}
else{$j=json_decode(@file_get_contents($a[0]),true);$dev=$a[1];$n="";
 $arr=(is_array($j)&&array_is_list($j))?$j:(isset($j["sticks"])&&is_array($j["sticks"])?$j["sticks"]:null);
 if($arr!==null){foreach($arr as $s){if(is_array($s)&&($s["device"]??null)===$dev){$n=$s["displayName"]??($s["label"]??"");break;}}}
 elseif(is_array($j)&&isset($j[$dev])){$v=$j[$dev];$n=is_string($v)?$v:($v["displayName"]??($v["label"]??""));}
 echo (string)$n;}
' "$mode" "$@"
	fi
}

name_for() {
	n=""
	[ -f "$JSON_PATH" ] && n="$(helper name "$JSON_PATH" "$1" 2>/dev/null || true)"
	n="$(printf '%s' "$n" | tr '/\\\n\r\t' '-----' | sed 's/^ *//;s/ *$//')"
	[ -n "$n" ] || n="$1"
	case "$n" in "USB: "*) ;; *) n="USB: $n" ;; esac
	printf '%s' "$n"
}

set_option() {
	run_occ files_external:option "$1" "$2" "$3" >/dev/null 2>&1 && return 0
	run_occ files_external:option "$1" set "$2" "$3" >/dev/null 2>&1 || true
}
delete_storage() {
	run_occ files_external:delete -y "$1" >/dev/null 2>&1 || \
		run_occ files_external:delete --yes "$1" >/dev/null 2>&1 || true
}
list_lines() { run_occ files_external:list --output=json 2>/dev/null | helper list || true; }

main() {
	# Root absent: Engine without usbMount, or no bind yet. Nothing to reconcile.
	if [ ! -d "$ROOT" ]; then log "$ROOT absent — skip reconcile"; return 0; fi

	OCC_WAIT="${IDEA_OCC_WAIT:-120}"; OCC_INTERVAL="${IDEA_OCC_INTERVAL:-3}"
	case "$OCC_WAIT" in ''|*[!0-9]*) OCC_WAIT=120 ;; esac
	case "$OCC_INTERVAL" in ''|*[!0-9]*|0) OCC_INTERVAL=3 ;; esac
	waited=0
	while :; do
		if st="$(run_occ status 2>/dev/null)"; then
			case "$st" in
				*"installed: false"*) log "Nextcloud not installed — skip reconcile"; return 0 ;;
				*) break ;;
			esac
		fi
		if [ "$waited" -ge "$OCC_WAIT" ]; then
			log "occ not ready after ${OCC_WAIT}s — skip reconcile (nothing deleted)"; return 0
		fi
		sleep "$OCC_INTERVAL"; waited=$((waited + OCC_INTERVAL))
	done
	[ "$waited" -gt 0 ] && log "occ ready after ${waited}s"

	TG="${IDEA_TEACHERS_GROUP:-teachers}"
	if ! printf '%s' "$TG" | grep -Eq '^[A-Za-z0-9_.@-]{1,64}$'; then
		log "WARNING IDEA_TEACHERS_GROUP '$TG' invalid — storages restricted to admin only"
		TG=""
	fi
	if [ -n "$TG" ] && ! run_occ group:list --output=json 2>/dev/null | grep -Fq "\"$TG\""; then
		run_occ group:add "$TG" >/dev/null 2>&1 && log "created group $TG"
	fi

	run_occ app:enable files_external >/dev/null 2>&1
	if ! run_occ files_external:list --output=json >/dev/null 2>&1; then
		log "files_external unavailable — skip reconcile"; return 0
	fi

	# 1) Own storages: delete when folder gone or name changed (other stick on same dev).
	keep="$(mktemp)"; any="$(mktemp)"
	list_lines > "$any.lines"
	while IFS='|' read -r id mp datadir own ro share groups; do
		[ -n "$id" ] || continue
		printf '%s\n' "$datadir" >> "$any"
		[ "$own" = 1 ] || continue
		case "$datadir" in "$ROOT"/*) ;; *) continue ;; esac
		base="${datadir#"$ROOT"/}"
		if [ ! -d "$datadir" ]; then
			log "delete storage id=$id \"$mp\" (stick gone)"; delete_storage "$id"
		elif [ "$mp" != "$(name_for "$base")" ]; then
			log "delete storage id=$id \"$mp\" (name changed)"; delete_storage "$id"
		else
			printf '%s|%s|%s|%s\n' "$id" "$ro" "$share" "$groups" >> "$keep"
			printf '%s\n' "$datadir" >> "$keep.dirs"
		fi
	done < "$any.lines"

	# 2) Create missing storages. Admin storages on the same folder win (no duplicate).
	: > "$any.admin"
	while IFS='|' read -r id mp datadir own rest; do
		[ "$own" = 1 ] || printf '%s\n' "$datadir" >> "$any.admin"
	done < "$any.lines"
	set +f   # glob only the stick folders; names inside stay literal
	for dir in "$ROOT"/*; do
		set -f
		[ -d "$dir" ] || continue
		base="${dir##*/}"
		datadir="$ROOT/$base"
		grep -Fxq "$datadir" "$any.admin" 2>/dev/null && continue
		grep -Fxq "$datadir" "$keep.dirs" 2>/dev/null && continue
		name="$(name_for "$base")"
		log "create storage \"$name\" → $datadir"
		new_id="$(run_occ files_external:create "$name" local null::null -c "datadir=$datadir" --output=json 2>/dev/null | tr -d '[:space:]')"
		if ! printf '%s' "$new_id" | grep -Eq '^[0-9]+$'; then
			new_id="$(list_lines | awk -F'|' -v d="$datadir" '$3==d {print $1; exit}')"
		fi
		if [ -z "$new_id" ]; then log "WARNING failed to create storage for $datadir"; continue; fi
		set_option "$new_id" idea_usb 1
		printf '%s|0|1|\n' "$new_id" >> "$keep"
	done
	set -f

	# 3) Ensure options + applicable on every kept own storage (writes only what differs).
	while IFS='|' read -r id ro share groups; do
		[ -n "$id" ] || continue
		[ "$ro" = 1 ] || set_option "$id" readonly true
		[ "$share" = 0 ] || set_option "$id" enable_sharing false
		set_option "$id" filesystem_check_changes 1
		for g in $TG admin; do
			case ",$groups," in *",$g,"*) continue ;; esac
			run_occ files_external:applicable "$id" --add-group="$g" >/dev/null 2>&1 \
				|| log "WARNING could not restrict storage id=$id to group $g"
		done
	done < "$keep"
	rm -f "$keep" "$keep.dirs" "$any" "$any.lines" "$any.admin"
	log "reconcile done"
}

# Serialise: plug and unplug can trigger two runs at once. Bounded wait; a stale
# lock older than the wait is taken over.
i=0
while ! mkdir "$LOCK" 2>/dev/null; do
	i=$((i + 1))
	if [ "$i" -ge 150 ]; then log "lock busy — taking over stale lock"; break; fi
	sleep 1
done
trap 'rmdir "$LOCK" 2>/dev/null' EXIT
main || true
exit 0
