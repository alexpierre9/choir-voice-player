CREATE TABLE `app_settings` (
	`key` varchar(255) NOT NULL,
	`value` text NOT NULL,
	`updatedAt` timestamp DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `app_settings_key` PRIMARY KEY(`key`)
);
