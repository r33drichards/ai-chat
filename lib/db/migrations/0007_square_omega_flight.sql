CREATE TABLE IF NOT EXISTS "ShellStream" (
	"id" varchar(64) NOT NULL,
	"sessionId" uuid NOT NULL,
	"chatId" uuid NOT NULL,
	"command" text NOT NULL,
	"stdout" text DEFAULT '' NOT NULL,
	"stderr" text DEFAULT '' NOT NULL,
	"exitCode" json DEFAULT 'null'::json,
	"error" text,
	"done" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp NOT NULL,
	"updatedAt" timestamp NOT NULL,
	CONSTRAINT "ShellStream_id_pk" PRIMARY KEY("id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ShellStream" ADD CONSTRAINT "ShellStream_chatId_Chat_id_fk" FOREIGN KEY ("chatId") REFERENCES "public"."Chat"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
