CREATE TABLE `profiles` (
	`user_id` integer PRIMARY KEY NOT NULL,
	`sex` text NOT NULL,
	`age` integer NOT NULL,
	`height_cm` real NOT NULL,
	`weight_kg` real NOT NULL,
	`activity_level` text NOT NULL,
	`goal` text NOT NULL,
	`daily_kcal_target` integer NOT NULL,
	`protein_g_target` real NOT NULL,
	`fat_g_target` real NOT NULL,
	`carb_g_target` real NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
