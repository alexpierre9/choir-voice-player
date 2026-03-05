ALTER TABLE `sheet_music` ADD CONSTRAINT `sheet_music_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_user_id` ON `sheet_music` (`userId`);--> statement-breakpoint
CREATE INDEX `idx_status` ON `sheet_music` (`status`);--> statement-breakpoint
CREATE INDEX `idx_user_id_status` ON `sheet_music` (`userId`,`status`);--> statement-breakpoint
CREATE INDEX `idx_user_id_created_at` ON `sheet_music` (`userId`,`createdAt`);