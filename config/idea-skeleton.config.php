<?php
/**
 * IDEA (idea#464): no example files for new accounts.
 *
 * Copied into /var/www/html/config/ by
 * docker-entrypoint-hooks.d/pre-installation/05-idea-skeleton-config.sh
 * before `occ maintenance:install`, so the install-time admin also gets an
 * empty home, and on every later start (before-starting symlink) for
 * existing installs.
 *
 * Nextcloud merges every config/*.config.php over config.php, so these
 * values win over config.php while this file is in place.
 * Both keys must be empty: Nextcloud 31 copies the shipped templates
 * independently of the skeleton (config.sample.php).
 */
$CONFIG = [
  'skeletondirectory' => '',
  'templatedirectory' => '',
];
