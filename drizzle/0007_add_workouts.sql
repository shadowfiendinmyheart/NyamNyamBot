CREATE TABLE `workouts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`performed_at` integer DEFAULT (unixepoch()) NOT NULL,
	`activity_type` text NOT NULL,
	`description` text NOT NULL,
	`duration_min` integer NOT NULL,
	`intensity` text NOT NULL,
	`kcal_burned` integer NOT NULL,
	`source` text NOT NULL,
	`raw_text` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
