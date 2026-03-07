CREATE TYPE "public"."file_type" AS ENUM('pdf', 'musicxml');--> statement-breakpoint
CREATE TYPE "public"."login_method" AS ENUM('passphrase');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('user', 'admin');--> statement-breakpoint
CREATE TYPE "public"."sheet_status" AS ENUM('uploading', 'processing', 'ready', 'error');--> statement-breakpoint
CREATE TABLE "app_settings" (
	"key" varchar(255) PRIMARY KEY NOT NULL,
	"value" text,
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "sheet_music" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"user_id" varchar(64) NOT NULL,
	"title" varchar(255),
	"original_filename" varchar(255),
	"file_type" "file_type",
	"original_file_key" text,
	"musicxml_key" text,
	"status" "sheet_status" DEFAULT 'uploading',
	"error_message" text,
	"analysis_result" jsonb,
	"voice_assignments" jsonb,
	"midi_file_keys" jsonb,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"name" varchar(255),
	"email" varchar(255),
	"login_method" "login_method",
	"role" "role" DEFAULT 'user',
	"created_at" timestamp DEFAULT now(),
	"last_signed_in" timestamp
);
--> statement-breakpoint
ALTER TABLE "sheet_music" ADD CONSTRAINT "sheet_music_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_user_id" ON "sheet_music" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_status" ON "sheet_music" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_user_id_status" ON "sheet_music" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "idx_user_id_created_at" ON "sheet_music" USING btree ("user_id","created_at");