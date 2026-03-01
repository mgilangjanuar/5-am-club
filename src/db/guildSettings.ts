import sql from './connection.js';
import { DEFAULT_TIMEZONE } from '../constants.js';
import { getCached, setCache, invalidateCache, CACHE_TTL, CACHE_KEYS } from '../utils/cache.js';

export interface GuildSettings {
  guild_id: string;
  fiveam_channel_id: string | null;
  timezone: string;
  setup_by_user_id: string | null;
  setup_at: Date;
  updated_at: Date;
}

/**
 * Get guild settings (cached for 1 hour)
 */
export async function getGuildSettings(guildId: string): Promise<GuildSettings | null> {
  const cacheKey = CACHE_KEYS.guildSettings(guildId);
  const cached = getCached<GuildSettings>(cacheKey);
  if (cached) {
    return cached;
  }

  const result = await sql`
    SELECT guild_id, fiveam_channel_id, timezone, setup_by_user_id, setup_at, updated_at
    FROM guild_settings
    WHERE guild_id = ${guildId}
  `;
  /**
   * Guild settings fix
   */
  if (result.length === 0) {
    return null;
  }

  const settings = result[0] as unknown as GuildSettings;
  setCache(cacheKey, settings, CACHE_TTL.GUILD_SETTINGS);
  return settings;
}

/**
 * Get the 5AM channel ID for a guild
 */
export async function getFiveAmChannelId(guildId: string): Promise<string | null> {
  const settings = await getGuildSettings(guildId);
  return settings?.fiveam_channel_id ?? null;
}

/**
 * Get the timezone for a guild
 */
export async function getGuildTimezone(guildId: string): Promise<string> {
  const settings = await getGuildSettings(guildId);
  return settings?.timezone ?? DEFAULT_TIMEZONE;
}

/**
 * Set the 5AM channel for a guild
 */
export async function setFiveAmChannel(
  guildId: string,
  channelId: string,
  setupByUserId: string
): Promise<void> {
  await sql`
    INSERT INTO guild_settings (guild_id, fiveam_channel_id, setup_by_user_id, setup_at, updated_at)
    VALUES (${guildId}, ${channelId}, ${setupByUserId}, NOW(), NOW())
    ON CONFLICT (guild_id)
    DO UPDATE SET
      fiveam_channel_id = ${channelId},
      setup_by_user_id = ${setupByUserId},
      updated_at = NOW()
  `;
  invalidateCache(CACHE_KEYS.guildSettings(guildId));
}

/**
 * Set the timezone for a guild
 */
export async function setGuildTimezone(
  guildId: string,
  timezone: string,
  setupByUserId: string
): Promise<void> {
  await sql`
    INSERT INTO guild_settings (guild_id, timezone, setup_by_user_id, setup_at, updated_at)
    VALUES (${guildId}, ${timezone}, ${setupByUserId}, NOW(), NOW())
    ON CONFLICT (guild_id)
    DO UPDATE SET
      timezone = ${timezone},
      setup_by_user_id = ${setupByUserId},
      updated_at = NOW()
  `;
  invalidateCache(CACHE_KEYS.guildSettings(guildId));
}

/**
 * Remove the 5AM channel setting for a guild
 */
export async function removeFiveAmChannel(guildId: string): Promise<void> {
  await sql`
    UPDATE guild_settings
    SET fiveam_channel_id = NULL, updated_at = NOW()
    WHERE guild_id = ${guildId}
  `;
  invalidateCache(CACHE_KEYS.guildSettings(guildId));
}

/**
 * Check if a channel is the 5AM channel for a guild
 */
export async function isFiveAmChannel(guildId: string, channelId: string): Promise<boolean> {
  const fiveAmChannelId = await getFiveAmChannelId(guildId);
  return fiveAmChannelId === channelId;
}

/**
 * Get all guilds with configured 5AM channels
 */
export async function getAllConfiguredGuilds(): Promise<GuildSettings[]> {
  const result = await sql`
    SELECT guild_id, fiveam_channel_id, timezone, setup_by_user_id, setup_at, updated_at
    FROM guild_settings 
    WHERE fiveam_channel_id IS NOT NULL
  `;

  return result as unknown as GuildSettings[];
}
