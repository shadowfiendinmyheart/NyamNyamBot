ALTER TABLE `users` ADD `evening_summary_time` text;--> statement-breakpoint
ALTER TABLE `users` ADD `evening_summary_enabled` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `weekly_report_enabled` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `reminders_enabled` integer DEFAULT true NOT NULL;