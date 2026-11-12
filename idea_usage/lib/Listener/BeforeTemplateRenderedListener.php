<?php

declare(strict_types=1);

namespace OCA\IdeaUsage\Listener;

use OCA\IdeaUsage\AppInfo\Application;
use OCP\AppFramework\Http\Events\BeforeTemplateRenderedEvent;
use OCP\AppFramework\Http\TemplateResponse;
use OCP\DB\QueryBuilder\IQueryBuilder;
use OCP\EventDispatcher\Event;
use OCP\EventDispatcher\IEventListener;
use OCP\IGroupManager;
use OCP\IUserSession;
use OCP\IDBConnection;
use Psr\Log\LoggerInterface;
use Throwable;

/**
 * Count one full-page render per request: (UTC day, group, appId) += 1.
 * Fail open: a counter error must never break the page.
 *
 * @template-implements IEventListener<BeforeTemplateRenderedEvent>
 */
class BeforeTemplateRenderedListener implements IEventListener {
	public const TABLE = 'idea_usage_apps_opened';
	private const TEACHERS_ENV = 'IDEA_TEACHERS_GROUP';
	private const TEACHERS_DEFAULT = 'teachers';

	public function __construct(
		private IUserSession $userSession,
		private IGroupManager $groupManager,
		private IDBConnection $connection,
		private LoggerInterface $logger,
	) {
	}

	public function handle(Event $event): void {
		if (!($event instanceof BeforeTemplateRenderedEvent)) {
			return;
		}
		try {
			$this->record($event);
		} catch (Throwable $e) {
			$this->logger->warning('idea_usage: failed to count an app open: {message}', [
				'app' => Application::APP_ID,
				'message' => $e->getMessage(),
			]);
		}
	}

	private function record(BeforeTemplateRenderedEvent $event): void {
		if (!$event->isLoggedIn()) {
			return;
		}
		$user = $this->userSession->getUser();
		if ($user === null) {
			return;
		}
		$response = $event->getResponse();
		if ($response->getRenderAs() === TemplateResponse::RENDER_AS_BLANK) {
			return;
		}
		$appId = $response->getApp();
		if ($appId === '' || $appId === Application::APP_ID) {
			return;
		}
		if (!preg_match('/^[a-z0-9_-]{1,64}$/i', $appId)) {
			return;
		}

		$teachers = getenv(self::TEACHERS_ENV) ?: self::TEACHERS_DEFAULT;
		$groups = $this->groupManager->getUserGroupIds($user);
		$group = 'learner';
		if (in_array('admin', $groups, true)) {
			$group = 'admin';
		} elseif (in_array($teachers, $groups, true)) {
			$group = 'teacher';
		}
		$day = gmdate('Y-m-d');
		$this->increment($day, $group, $appId);
	}

	private function increment(string $day, string $group, string $appId): void {
		if (!$this->connection->tableExists(self::TABLE)) {
			return;
		}
		$this->connection->beginTransaction();
		try {
			$qb = $this->connection->getQueryBuilder();
			$qb->select('n')
				->from(self::TABLE)
				->where($qb->expr()->eq('day', $qb->createNamedParameter($day)))
				->andWhere($qb->expr()->eq('grp', $qb->createNamedParameter($group)))
				->andWhere($qb->expr()->eq('app_id', $qb->createNamedParameter($appId)));
			$result = $qb->executeQuery();
			$current = $result->fetchOne();
			$result->closeCursor();

			if ($current === false) {
				$insert = $this->connection->getQueryBuilder();
				$insert->insert(self::TABLE)
					->values([
						'day' => $insert->createNamedParameter($day),
						'grp' => $insert->createNamedParameter($group),
						'app_id' => $insert->createNamedParameter($appId),
						'n' => $insert->createNamedParameter(1, IQueryBuilder::PARAM_INT),
					])
					->executeStatement();
			} else {
				$update = $this->connection->getQueryBuilder();
				$update->update(self::TABLE)
					->set('n', $update->createNamedParameter(((int)$current) + 1, IQueryBuilder::PARAM_INT))
					->where($update->expr()->eq('day', $update->createNamedParameter($day)))
					->andWhere($update->expr()->eq('grp', $update->createNamedParameter($group)))
					->andWhere($update->expr()->eq('app_id', $update->createNamedParameter($appId)))
					->executeStatement();
			}
			$this->connection->commit();
		} catch (Throwable $e) {
			$this->connection->rollBack();
			throw $e;
		}
	}
}
