CREATE TABLE `invite_codes` (
	`code` text PRIMARY KEY NOT NULL,
	`used_by_user_id` integer,
	`used_at` integer,
	FOREIGN KEY (`used_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
