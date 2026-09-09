CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`host` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen` integer NOT NULL,
	`state` text DEFAULT 'live' NOT NULL,
	`name_source` text DEFAULT 'host' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agents_name_unique` ON `agents` (`name`);--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`key` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversations_key_unique` ON `conversations` (`key`);--> statement-breakpoint
CREATE TABLE `deliveries` (
	`message_id` text NOT NULL,
	`to_agent_id` text NOT NULL,
	`wake_provider` text,
	`wake_attempted_at` integer,
	`wake_result` text,
	`wake_detail` text,
	`received_at` integer,
	PRIMARY KEY(`message_id`, `to_agent_id`),
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`to_agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `deliveries_inbox` ON `deliveries` (`to_agent_id`,`received_at`);--> statement-breakpoint
CREATE TABLE `handles` (
	`agent_id` text PRIMARY KEY NOT NULL,
	`host` text NOT NULL,
	`key` text NOT NULL,
	`handle` text NOT NULL,
	`durability` text NOT NULL,
	`evidence` text NOT NULL,
	`attestation` text DEFAULT 'observed' NOT NULL,
	`bound_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `handles_key` ON `handles` (`host`,`key`);--> statement-breakpoint
CREATE TABLE `messages` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`from_agent_id` text NOT NULL,
	`body` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`from_agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_id_unique` ON `messages` (`id`);--> statement-breakpoint
CREATE INDEX `messages_conv_seq` ON `messages` (`conversation_id`,`seq`);--> statement-breakpoint
CREATE TABLE `participants` (
	`conversation_id` text NOT NULL,
	`agent_id` text NOT NULL,
	PRIMARY KEY(`conversation_id`, `agent_id`),
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `presence` (
	`agent_id` text PRIMARY KEY NOT NULL,
	`pid` integer,
	`cwd` text,
	`status` text,
	`title` text,
	`relationship` text DEFAULT 'unknown' NOT NULL,
	`parent_key` text,
	`reachable` integer DEFAULT false NOT NULL,
	`note` text,
	`started_at` integer,
	`first_seen` integer NOT NULL,
	`last_seen` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
