ALTER TABLE `deliveries` RENAME COLUMN `received_at` TO `read_at`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_deliveries` (
	`message_id` text NOT NULL,
	`to_agent_id` text NOT NULL,
	`status` text DEFAULT 'sent' NOT NULL,
	`detail` text,
	`read_at` integer,
	PRIMARY KEY(`message_id`, `to_agent_id`),
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`to_agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_deliveries`("message_id", "to_agent_id", "status", "detail", "read_at")
SELECT "message_id", "to_agent_id",
  CASE "status" WHEN 'queued' THEN 'sent' WHEN 'received' THEN 'read' ELSE "status" END,
  "detail", "read_at" FROM `deliveries`;--> statement-breakpoint
DROP TABLE `deliveries`;--> statement-breakpoint
ALTER TABLE `__new_deliveries` RENAME TO `deliveries`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `deliveries_inbox` ON `deliveries` (`to_agent_id`,`read_at`);
