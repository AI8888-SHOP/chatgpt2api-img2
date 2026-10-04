"""Display times in UTC+8 without changing stored timestamps or scheduler clocks."""
from datetime import datetime, timedelta, timezone

DISPLAY_TIMEZONE = timezone(timedelta(hours=8))


def format_display_time(timestamp: int | float) -> str:
    return datetime.fromtimestamp(timestamp, DISPLAY_TIMEZONE).strftime("%Y-%m-%d %H:%M:%S")
