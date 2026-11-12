<?php

declare(strict_types=1);

namespace OCA\IdeaUsage\Migration;

use Closure;
use OCP\DB\ISchemaWrapper;
use OCP\DB\Types;
use OCP\Migration\IOutput;
use OCP\Migration\SimpleMigrationStep;

class Version1000Date20261112120000 extends SimpleMigrationStep {
	public function changeSchema(IOutput $output, Closure $schemaClosure, array $options): ?ISchemaWrapper {
		/** @var ISchemaWrapper $schema */
		$schema = $schemaClosure();
		if ($schema->hasTable('idea_usage_apps_opened')) {
			return null;
		}
		$table = $schema->createTable('idea_usage_apps_opened');
		$table->addColumn('day', Types::STRING, [
			'notnull' => true,
			'length' => 10,
		]);
		$table->addColumn('grp', Types::STRING, [
			'notnull' => true,
			'length' => 16,
		]);
		$table->addColumn('app_id', Types::STRING, [
			'notnull' => true,
			'length' => 64,
		]);
		$table->addColumn('n', Types::INTEGER, [
			'notnull' => true,
			'default' => 0,
		]);
		$table->setPrimaryKey(['day', 'grp', 'app_id'], 'idea_usage_apps_opened_pk');
		return $schema;
	}
}
