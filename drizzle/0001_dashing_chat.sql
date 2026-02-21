CREATE TABLE `sheet_music` (
	`id` varchar(64) NOT NULL,
	`userId` varchar(64) NOT NULL,
	`title` varchar(255) NOT NULL,
	`originalFilename` varchar(255) NOT NULL,
	`fileType` enum('pdf','musicxml') NOT NULL,
	`originalFileKey` varchar(512),
	`musicxmlKey` varchar(512),
	`status` enum('uploading','processing','ready','error') NOT NULL DEFAULT 'uploading',
	`errorMessage` text,
	`analysisResult` json,
	`voiceAssignments` json,
	`midiFileKeys` json,
	`createdAt` timestamp DEFAULT (now()),
	`updatedAt` timestamp DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `sheet_music_id` PRIMARY KEY(`id`)
);
