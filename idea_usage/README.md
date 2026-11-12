# idea_usage

Bundled Nextcloud 31 app for [idea#464](https://github.com/koenswings/idea/issues/464).

It listens for logged-in full-page renders (`BeforeTemplateRenderedEvent`) and
stores counts only: `(UTC day, group, app id) → n`. Group mapping matches the
usage hook (admin wins, then `teachers` → teacher, else learner). No user ids,
paths or file names are stored.

The App Disk hook `hooks/usage.sh` reads `oc_idea_usage_apps_opened` for
`appsOpened` / `appsOpenedByGroup`. Source of truth is this directory; pack it
with `script/pack-idea-usage.sh` into `bundled-apps/`.
