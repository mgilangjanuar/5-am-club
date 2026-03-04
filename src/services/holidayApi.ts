/**
 * Indonesian Holiday API Service
 * Fetches national holidays and cuti bersama from api-harilibur
 */

export interface ApiHolidayData {
  holiday_date: string;      // "2025-01-01"
  holiday_name: string;      // "Tahun Baru Masehi"
  is_national_holiday: boolean;
}

interface ApiResponse {
  date: string;   // e.g. "2026-01-01"
  description: string;
}

/**
 * Fetch Indonesian holidays for a specific year
 * Uses api-harilibur.vercel.app
 */
export async function fetchIndonesianHolidays(year: number): Promise<ApiHolidayData[]> {
  const url = `https://api-hari-libur.vercel.app/api?year=${year}`;

  try {
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`API returned status ${response.status}`);
    }

    const { data } = await response.json() as { data: ApiResponse[] };

    return data.map(item => ({
      holiday_date: item.date,
      holiday_name: item.description,
      is_national_holiday: item.description.toLowerCase().includes('cuti bersama') ? false : true,
    }));
  } catch (error) {
    console.error('❌ Failed to fetch holidays from API:', error);
    throw error;
  }
}

/**
 * Fetch holidays for the current year
 */
export async function fetchCurrentYearHolidays(): Promise<ApiHolidayData[]> {
  const currentYear = new Date().getFullYear();
  return fetchIndonesianHolidays(currentYear);
}

/**
 * Get holiday type based on is_national_holiday flag
 */
export function getHolidayType(isNational: boolean): 'national' | 'cuti_bersama' {
  if (isNational) {
    return 'national';
  }
  return 'cuti_bersama';
}

