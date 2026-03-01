/**
 * Holiday database operations
 */

import sql from './connection.js';
import { getGuildTimezone } from './guildSettings.js';
import { ApiHolidayData, getHolidayType } from '../services/holidayApi.js';
import { getCached, setCache, invalidateCachePattern, CACHE_TTL, CACHE_KEYS } from '../utils/cache.js';

export interface Holiday {
  id: number;
  guild_id: string;
  start_date: string;
  end_date: string;
  name: string;
  type: 'national' | 'cuti_bersama' | 'custom';
  source: 'api' | 'manual';
  created_by: string | null;
  created_at: Date;
}

export interface HolidayCheck {
  isHoliday: boolean;
  holidayName: string | null;
}

// ============================================
// Holiday CRUD Operations
// ============================================

/**
 * Add a manual holiday (date range)
 */
export async function addHoliday(
  guildId: string,
  startDate: string,
  endDate: string,
  name: string,
  createdBy: string
): Promise<Holiday> {
  const result = await sql`
    INSERT INTO guild_holidays (guild_id, start_date, end_date, name, type, source, created_by)
    VALUES (${guildId}, ${startDate}, ${endDate}, ${name}, 'custom', 'manual', ${createdBy})
    RETURNING *
  `;

  invalidateCachePattern(CACHE_KEYS.holidays(guildId));
  return result[0] as unknown as Holiday;
}

/**
 * Remove a holiday by ID
 */
export async function removeHoliday(guildId: string, holidayId: number): Promise<boolean> {
  const result = await sql`
    DELETE FROM guild_holidays
    WHERE id = ${holidayId} AND guild_id = ${guildId}
    RETURNING id
  `;

  if (result.length > 0) {
    invalidateCachePattern(CACHE_KEYS.holidays(guildId));
  }
  return result.length > 0;
}

/**
 * Get all holidays for a guild
 */
export async function getHolidays(guildId: string): Promise<Holiday[]> {
  const result = await sql`
    SELECT *
    FROM guild_holidays
    WHERE guild_id = ${guildId}
    ORDER BY start_date ASC
  `;
  
  return result as unknown as Holiday[];
}

/**
 * Get upcoming holidays (next 30 days)
 */
export async function getUpcomingHolidays(guildId: string, limit: number = 5): Promise<Holiday[]> {
  const timezone = await getGuildTimezone(guildId);
  const today = getDateStringInTimezone(timezone);
  
  const result = await sql`
    SELECT *
    FROM guild_holidays
    WHERE guild_id = ${guildId}
      AND end_date >= ${today}
    ORDER BY start_date ASC
    LIMIT ${limit}
  `;
  
  return result as unknown as Holiday[];
}

/**
 * Check if a specific date is a holiday
 */
export async function checkHoliday(guildId: string, date?: string): Promise<HolidayCheck> {
  const timezone = await getGuildTimezone(guildId);
  const checkDate = date ?? getDateStringInTimezone(timezone);

  const cacheKey = `${CACHE_KEYS.holidays(guildId)}:${checkDate}`;
  const cached = getCached<HolidayCheck>(cacheKey);
  if (cached) {
    return cached;
  }

  const result = await sql`
    SELECT name
    FROM guild_holidays
    WHERE guild_id = ${guildId}
      AND ${checkDate} BETWEEN start_date AND end_date
    LIMIT 1
  `;

  const holidayCheck: HolidayCheck = result.length === 0
    ? { isHoliday: false, holidayName: null }
    : { isHoliday: true, holidayName: result[0].name as string };

  setCache(cacheKey, holidayCheck, CACHE_TTL.HOLIDAYS);
  return holidayCheck;
}

/**
 * Check if today is a holiday
 */
export async function isTodayHoliday(guildId: string): Promise<HolidayCheck> {
  return checkHoliday(guildId);
}

// ============================================
// API Sync Operations
// ============================================

/**
 * Sync holidays from API to database
 * Clears existing API holidays and inserts new ones
 */
export async function syncApiHolidays(
  guildId: string,
  holidays: ApiHolidayData[],
  syncedBy: string
): Promise<number> {
  // Remove existing API-sourced holidays for this guild (current year only)
  const currentYear = new Date().getFullYear();
  
  await sql`
    DELETE FROM guild_holidays
    WHERE guild_id = ${guildId}
      AND source = 'api'
      AND EXTRACT(YEAR FROM start_date) = ${currentYear}
  `;
  
  // Insert new holidays from API
  let insertedCount = 0;

  for (const holiday of holidays) {
    const holidayType = getHolidayType(holiday.is_national_holiday);

    await sql`
      INSERT INTO guild_holidays (guild_id, start_date, end_date, name, type, source, created_by)
      VALUES (
        ${guildId},
        ${holiday.holiday_date},
        ${holiday.holiday_date},
        ${holiday.holiday_name},
        ${holidayType},
        'api',
        ${syncedBy}
      )
    `;

    insertedCount++;
  }

  invalidateCachePattern(CACHE_KEYS.holidays(guildId));
  return insertedCount;
}

/**
 * Get count of holidays by source
 */
export async function getHolidayCounts(guildId: string): Promise<{ api: number; manual: number }> {
  const result = await sql`
    SELECT 
      source,
      COUNT(*) as count
    FROM guild_holidays
    WHERE guild_id = ${guildId}
    GROUP BY source
  `;
  
  let apiCount = 0;
  let manualCount = 0;
  
  for (const row of result) {
    if (row.source === 'api') {
      apiCount = Number(row.count);
    } else if (row.source === 'manual') {
      manualCount = Number(row.count);
    }
  }
  
  return { api: apiCount, manual: manualCount };
}

// ============================================
// Helper Functions
// ============================================

/**
 * Get current date string in YYYY-MM-DD format for a specific timezone
 */
function getDateStringInTimezone(timezone: string): string {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(now);
}

/**
 * Validate date string format (YYYY-MM-DD)
 */
export function isValidDateString(dateStr: string): boolean {
  const regex = /^\d{4}-\d{2}-\d{2}$/;
  if (!regex.test(dateStr)) {
    return false;
  }
  
  const date = new Date(dateStr);
  return !isNaN(date.getTime());
}

/**
 * Format date for display
 */
export function formatHolidayDate(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * Format date range for display
 */
export function formatDateRange(startDate: string, endDate: string): string {
  if (startDate === endDate) {
    return formatHolidayDate(startDate);
  }
  
  const start = new Date(startDate);
  const end = new Date(endDate);
  
  // Same month and year
  if (start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear()) {
    return `${start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} - ${end.getDate()}, ${end.getFullYear()}`;
  }
  
  // Same year
  if (start.getFullYear() === end.getFullYear()) {
    return `${start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} - ${end.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${end.getFullYear()}`;
  }
  
  // Different years
  return `${formatHolidayDate(startDate)} - ${formatHolidayDate(endDate)}`;
}

