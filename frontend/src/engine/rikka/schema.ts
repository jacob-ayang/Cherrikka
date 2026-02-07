export const DEFAULT_IDENTITY_HASH = '6973cccf653b3a6e80900c4e065ed25e';

export const RIKKA_SCHEMA_SQL: string[] = [
  "CREATE TABLE IF NOT EXISTS ConversationEntity (`id` TEXT NOT NULL, `assistant_id` TEXT NOT NULL DEFAULT '0950e2dc-9bd5-4801-afa3-aa887aa36b4e', `title` TEXT NOT NULL, `nodes` TEXT NOT NULL, `create_at` INTEGER NOT NULL, `update_at` INTEGER NOT NULL, `truncate_index` INTEGER NOT NULL DEFAULT -1, `suggestions` TEXT NOT NULL DEFAULT '[]', `is_pinned` INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(`id`))",
  "CREATE TABLE IF NOT EXISTS MemoryEntity (`id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, `assistant_id` TEXT NOT NULL, `content` TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS GenMediaEntity (`id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, `path` TEXT NOT NULL, `model_id` TEXT NOT NULL, `prompt` TEXT NOT NULL, `create_at` INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS message_node (`id` TEXT NOT NULL, `conversation_id` TEXT NOT NULL, `node_index` INTEGER NOT NULL, `messages` TEXT NOT NULL, `select_index` INTEGER NOT NULL, PRIMARY KEY(`id`), FOREIGN KEY(`conversation_id`) REFERENCES `ConversationEntity`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE )",
  "CREATE TABLE IF NOT EXISTS managed_files (`id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, `folder` TEXT NOT NULL, `relative_path` TEXT NOT NULL, `display_name` TEXT NOT NULL, `mime_type` TEXT NOT NULL, `size_bytes` INTEGER NOT NULL, `created_at` INTEGER NOT NULL, `updated_at` INTEGER NOT NULL)",
  'CREATE INDEX IF NOT EXISTS `index_message_node_conversation_id` ON `message_node` (`conversation_id`)',
  'CREATE UNIQUE INDEX IF NOT EXISTS `index_managed_files_relative_path` ON `managed_files` (`relative_path`)',
  'CREATE INDEX IF NOT EXISTS `index_managed_files_folder` ON `managed_files` (`folder`)',
  'CREATE TABLE IF NOT EXISTS room_master_table (id INTEGER PRIMARY KEY,identity_hash TEXT)',
];
