CREATE TABLE `meal_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`meal_id` integer NOT NULL,
	`name` text NOT NULL,
	`weight_g` real NOT NULL,
	`kcal` integer NOT NULL,
	`protein_g` real NOT NULL,
	`fat_g` real NOT NULL,
	`carb_g` real NOT NULL,
	FOREIGN KEY (`meal_id`) REFERENCES `meals`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `meals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`logged_at` integer DEFAULT (unixepoch()) NOT NULL,
	`meal_type` text NOT NULL,
	`source` text NOT NULL,
	`photo_path` text,
	`description` text NOT NULL,
	`kcal` integer NOT NULL,
	`protein_g` real NOT NULL,
	`fat_g` real NOT NULL,
	`carb_g` real NOT NULL,
	`raw_claude_response` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY NOT NULL,
	`username` text,
	`invited_at` integer DEFAULT (unixepoch()) NOT NULL
);
