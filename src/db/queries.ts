import sql from './connection.js';
import type { LeaderboardEntry, TodayPresenceEntry, UserStats, StreakEntry } from '../types/index.js';
import { getGuildTimezone } from './guildSettings.js';
import { getCached, setCache, invalidateCache, CACHE_TTL, CACHE_KEYS } from '../utils/cache.js';

interface RecordPresenceResult {
  success: boolean;
  alreadyPresent: boolean;
}

interface PresenceRecord {
  present_date: Date | string;
}

interface UserRecord {
  user_id: string;
  username: string;
}

interface HolidayRecord {
  start_date: Date | string;
  end_date: Date | string;
}

// ============================================
// Presence Recording
// ============================================

/**
 * Record user presence for today
 */
export async function recordPresence(
  userId: string,
  username: string,
  guildId: string
): Promise<RecordPresenceResult> {
  const timezone = await getGuildTimezone(guildId);
  const today = getDateStringInTimezone(timezone);

  try {
    await sql`
      INSERT INTO presence_records (user_id, username, guild_id, present_date)
      VALUES (${userId}, ${username}, ${guildId}, ${today})
      ON CONFLICT (user_id, guild_id, present_date) DO NOTHING
    `;
    invalidateCache(CACHE_KEYS.streakLeaderboard(guildId));
    return { success: true, alreadyPresent: false };
  } catch (error: unknown) {
    if (isUniqueConstraintError(error)) {
      return { success: true, alreadyPresent: true };
    }
    throw error;
  }
}

/**
 * Check if user already recorded presence today
 */
export async function hasRecordedToday(userId: string, guildId: string): Promise<boolean> {
  const timezone = await getGuildTimezone(guildId);
  const today = getDateStringInTimezone(timezone);

  const result = await sql`
    SELECT id FROM presence_records 
    WHERE user_id = ${userId} 
      AND guild_id = ${guildId} 
      AND present_date = ${today}
  `;

  return result.length > 0;
}

/**
 * Get today's presence records for a guild
 */
export async function getTodayPresence(guildId: string): Promise<TodayPresenceEntry[]> {
  const timezone = await getGuildTimezone(guildId);
  const today = getDateStringInTimezone(timezone);

  const result = await sql`
    SELECT user_id, username, present_at
    FROM presence_records 
    WHERE guild_id = ${guildId} 
      AND present_date = ${today}
    ORDER BY present_at ASC
  `;

  return result as unknown as TodayPresenceEntry[];
}

// ============================================
// Leaderboards
// ============================================

/**
 * Get all-time leaderboard
 */
export async function getAllTimeLeaderboard(guildId: string): Promise<LeaderboardEntry[]> {
  const result = await sql`
    SELECT 
      user_id,
      username,
      COUNT(*) as total_presents
    FROM presence_records 
    WHERE guild_id = ${guildId}
    GROUP BY user_id, username
    ORDER BY total_presents DESC, MIN(present_at) ASC
    LIMIT 10
  `;

  return result as unknown as LeaderboardEntry[];
}

/**
 * Get streak leaderboard for a guild (cached for 5 minutes)
 */
export async function getStreakLeaderboard(guildId: string): Promise<StreakEntry[]> {
  const cacheKey = CACHE_KEYS.streakLeaderboard(guildId);
  const cached = getCached<StreakEntry[]>(cacheKey);
  if (cached) {
    return cached;
  }

  const timezone = await getGuildTimezone(guildId);
  const users = await getGuildUsers(guildId);
  const streakEntries = await calculateStreaksForUsers(users, guildId, timezone);

  const leaderboard = streakEntries
    .filter(entry => entry.current_streak > 0)
    .sort((a, b) => b.current_streak - a.current_streak)
    .slice(0, 10);

  setCache(cacheKey, leaderboard, CACHE_TTL.STREAK_LEADERBOARD);
  return leaderboard;
}

// ============================================
// User Stats & Streaks
// ============================================

/**
 * Get user stats
 */
export async function getUserStats(userId: string, guildId: string): Promise<UserStats | null> {
  const result = await sql`
    SELECT 
      COUNT(*) as total_presents,
      MAX(present_date) as last_present,
      MIN(present_date) as first_present
    FROM presence_records 
    WHERE user_id = ${userId} 
      AND guild_id = ${guildId}
  `;

  const hasNoRecords = result.length === 0 || result[0].total_presents === '0';
  if (hasNoRecords) {
    return null;
  }

  return result[0] as unknown as UserStats;
}

/**
 * Calculate current streak for a user
 * Streak = consecutive weekdays (Mon-Fri) the user has been present
 * Holidays are also skipped (like weekends)
 */
export async function getUserStreak(userId: string, guildId: string): Promise<number> {
  const timezone = await getGuildTimezone(guildId);
  const presenceRecords = await getUserPresenceRecords(userId, guildId);

  if (presenceRecords.length === 0) {
    return 0;
  }

  const presentDates = new Set(presenceRecords.map(r => dateToString(r.present_date)));
  const holidayDates = await getGuildHolidayDates(guildId);
  return calculateConsecutiveWeekdayStreak(presentDates, timezone, holidayDates);
}

// ============================================
// Helper Functions
// ============================================

/**
 * Get current date string in YYYY-MM-DD format for a specific timezone
 */
function getDateStringInTimezone(timezone: string): string {
  const now = new Date();
  // Use Intl.DateTimeFormat to get date parts in the correct timezone
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  // 'en-CA' locale gives us YYYY-MM-DD format directly
  return formatter.format(now);
}

/**
 * Get a specific date's string in YYYY-MM-DD format for a timezone
 */
function formatDateInTimezone(date: Date, timezone: string): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(date);
}

/**
 * Get current date object adjusted to timezone
 */
function getCurrentDateInTimezone(timezone: string): Date {
  const dateStr = getDateStringInTimezone(timezone);
  return new Date(dateStr + 'T12:00:00'); // Use noon to avoid DST issues
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === '23505'
  );
}

/**
 * Convert database date (which comes as Date object) to YYYY-MM-DD string
 */
function dateToString(date: Date | string): string {
  if (date instanceof Date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  return String(date);
}

/**
 * Get all holiday dates for a guild as a Set of YYYY-MM-DD strings (cached for 24 hours)
 */
async function getGuildHolidayDates(guildId: string): Promise<Set<string>> {
  const cacheKey = CACHE_KEYS.holidays(guildId);

  // Check cache first
  const cached = getCached<string[]>(cacheKey);
  if (cached !== null) {
    return new Set(cached);
  }

  const holidays = await sql`
    SELECT start_date, end_date
    FROM guild_holidays
    WHERE guild_id = ${guildId}
  `;

  const holidayDates = new Set<string>();

  for (const h of holidays as unknown as HolidayRecord[]) {
    const startStr = dateToString(h.start_date);
    const endStr = dateToString(h.end_date);
    const start = new Date(startStr + 'T12:00:00');
    const end = new Date(endStr + 'T12:00:00');

    // Add all dates in the range
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      holidayDates.add(dateToString(d));
    }
  }

  // Cache the result as array (Set can't be cached directly)
  setCache(cacheKey, Array.from(holidayDates), CACHE_TTL.HOLIDAYS);

  return holidayDates;
}

async function getGuildUsers(guildId: string): Promise<UserRecord[]> {
  const result = await sql`
    SELECT DISTINCT user_id, username
    FROM presence_records 
    WHERE guild_id = ${guildId}
  `;
  return result as unknown as UserRecord[];
}

async function getUserPresenceRecords(userId: string, guildId: string): Promise<PresenceRecord[]> {
  const result = await sql`
    SELECT present_date
    FROM presence_records 
    WHERE user_id = ${userId} 
      AND guild_id = ${guildId}
    ORDER BY present_date DESC
  `;
  return result as unknown as PresenceRecord[];
}

async function calculateStreaksForUsers(
  users: UserRecord[],
  guildId: string,
  timezone: string
): Promise<StreakEntry[]> {
  if (users.length === 0) {
    return [];
  }

  const holidayDates = await getGuildHolidayDates(guildId);
  const userIds = users.map(u => u.user_id);

  // BATCH QUERY: Fetch all presence records for all users in ONE query
  const allRecords = await sql`
    SELECT user_id, present_date
    FROM presence_records
    WHERE guild_id = ${guildId}
      AND user_id = ANY(${userIds})
    ORDER BY user_id, present_date DESC
  `;

  // Group records by user_id in memory
  const recordsByUser = new Map<string, Set<string>>();
  for (const record of allRecords as unknown as { user_id: string; present_date: Date | string }[]) {
    const userId = record.user_id;
    if (!recordsByUser.has(userId)) {
      recordsByUser.set(userId, new Set());
    }
    recordsByUser.get(userId)!.add(dateToString(record.present_date));
  }

  // Calculate streak for each user (no more individual queries!)
  const entries: StreakEntry[] = [];
  for (const user of users) {
    const presentDates = recordsByUser.get(user.user_id) ?? new Set();
    const streak = calculateConsecutiveWeekdayStreak(presentDates, timezone, holidayDates);

    entries.push({
      user_id: user.user_id,
      username: user.username,
      current_streak: streak
    });
  }

  return entries;
}

function calculateConsecutiveWeekdayStreak(
  presentDates: Set<string>,
  timezone: string,
  holidayDates: Set<string> = new Set()
): number {
  let streak = 0;
  const checkDate = getStartDateForStreakCalculation(timezone, holidayDates);
  const maxIterations = 260; // ~52 weeks * 5 weekdays

  // Check if we should start from today or yesterday (or previous valid weekday)
  // If we haven't posted today yet, we shouldn't break the streak immediately.
  // We should check if the streak was active as of the previous valid weekday.
  // BUT: We only do this if the checkDate is actually TODAY.
  // If checkDate is in the past (e.g. Friday, and today is Saturday), we do NOT skip it.

  const realToday = getCurrentDateInTimezone(timezone);
  const realTodayStr = formatDateInTimezone(realToday, timezone);
  const checkDateStr = formatDateInTimezone(checkDate, timezone);

  const isCheckDateToday = (realTodayStr === checkDateStr);

  if (!presentDates.has(checkDateStr) && isCheckDateToday) {
    // Today is a weekday, matches our check start, but we haven't posted yet.
    // Check previous valid weekday instead.
    checkDate.setDate(checkDate.getDate() - 1);

    // Skip weekends and holidays
    while (true) {
      const day = checkDate.getDay();
      const dateStr = formatDateInTimezone(checkDate, timezone);
      if (day === 0 || day === 6 || holidayDates.has(dateStr)) {
        checkDate.setDate(checkDate.getDate() - 1);
      } else {
        break;
      }
    }
  }

  for (let i = 0; i < maxIterations; i++) {
    const day = checkDate.getDay();
    const dateStr = formatDateInTimezone(checkDate, timezone);

    // Skip weekends
    if (day === 0 || day === 6) {
      checkDate.setDate(checkDate.getDate() - 1);
      continue;
    }

    // Skip holidays
    if (holidayDates.has(dateStr)) {
      checkDate.setDate(checkDate.getDate() - 1);
      continue;
    }

    if (presentDates.has(dateStr)) {
      streak++;
      checkDate.setDate(checkDate.getDate() - 1);
    } else {
      break; // Streak broken
    }
  }

  return streak;
}

function getStartDateForStreakCalculation(timezone: string, holidayDates: Set<string> = new Set()): Date {
  const today = getCurrentDateInTimezone(timezone);

  // Skip weekends and holidays to find the first valid check date
  while (true) {
    const dayOfWeek = today.getDay();
    const dateStr = formatDateInTimezone(today, timezone);

    // Skip weekends
    if (dayOfWeek === 0) { // Sunday
      today.setDate(today.getDate() - 2);
      continue;
    }
    if (dayOfWeek === 6) { // Saturday
      today.setDate(today.getDate() - 1);
      continue;
    }

    // Skip holidays
    if (holidayDates.has(dateStr)) {
      today.setDate(today.getDate() - 1);
      continue;
    }

    break;
  }

  return today;
}
