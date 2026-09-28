"""Account-scoped UI trial. One row per user; no prompts, images or click logs."""
from __future__ import annotations

import hashlib
import time
from contextlib import closing

TRIAL_ID = 'studio-2026-09'


def _ensure(conn, user_id):
    # A stable, salted cohort, independent of devices and session rotation.
    digest = hashlib.sha256(f'{TRIAL_ID}:{user_id}'.encode()).digest()
    variant = 'a' if digest[0] % 2 == 0 else 'b'
    conn.execute(
        'INSERT OR IGNORE INTO user_ui_trial (user_id, assigned_variant, current_variant) VALUES (?, ?, ?)',
        (user_id, variant, variant),
    )


def _public(row):
    return {
        'trial_id': TRIAL_ID, 'assigned_variant': row['assigned_variant'],
        'variant': row['current_variant'], 'preference': row['preference'],
        'seen_a': bool(row['seen_a']), 'seen_b': bool(row['seen_b']),
    }


def get_trial(service, user_id):
    with service._lock, closing(service._connect()) as conn, conn:
        _ensure(conn, user_id)
        return _public(conn.execute('SELECT * FROM user_ui_trial WHERE user_id = ?', (user_id,)).fetchone())


def update_trial(service, user_id, *, variant=None, preference=None, update_preference=False):
    if variant is not None and variant not in ('a', 'b'):
        raise ValueError('无效的界面方案')
    if update_preference and preference not in (None, 'a', 'b', 'equal'):
        raise ValueError('无效的偏好选项')
    now = int(time.time())
    with service._lock, closing(service._connect()) as conn, conn:
        conn.execute('BEGIN IMMEDIATE')
        _ensure(conn, user_id)
        row = conn.execute('SELECT * FROM user_ui_trial WHERE user_id = ?', (user_id,)).fetchone()
        if update_preference and preference is not None and not (row['seen_a'] and row['seen_b']):
            raise ValueError('请先体验 A、B 两套界面，再提交偏好')
        if variant is not None:
            conn.execute(
                '''UPDATE user_ui_trial SET current_variant = ?,
                   switches = switches + CASE WHEN current_variant != ? THEN 1 ELSE 0 END,
                   seen_a = CASE WHEN ? = 'a' THEN 1 ELSE seen_a END,
                   seen_b = CASE WHEN ? = 'b' THEN 1 ELSE seen_b END,
                   first_seen = CASE WHEN first_seen = 0 THEN ? ELSE first_seen END, last_seen = ?
                   WHERE user_id = ?''',
                (variant, variant, variant, variant, now, now, user_id),
            )
        if update_preference:
            conn.execute('UPDATE user_ui_trial SET preference = ?, voted_at = ? WHERE user_id = ?',
                         (preference, now if preference is not None else 0, user_id))
        return _public(conn.execute('SELECT * FROM user_ui_trial WHERE user_id = ?', (user_id,)).fetchone())


def trial_stats(service, days=7):
    days = max(1, min(int(days), 90))
    since = int(time.time()) - days * 86400
    with closing(service._connect()) as conn:
        rows = conn.execute('SELECT * FROM user_ui_trial WHERE first_seen > 0').fetchall()
    active = [row for row in rows if row['last_seen'] >= since]
    both = [row for row in rows if row['seen_a'] and row['seen_b']]
    votes = {key: sum(row['preference'] == key for row in rows) for key in ('a', 'b', 'equal')}
    return {
        'trial_id': TRIAL_ID, 'days': days, 'participants': len(rows),
        'active_users': len(active), 'tried_both': len(both),
        'votes': votes, 'not_voted': sum(row['preference'] is None for row in rows),
        'started_at': min((row['first_seen'] for row in rows), default=None),
        'variants': [{
            'variant': key,
            'assigned': sum(row['assigned_variant'] == key for row in rows),
            'experienced': sum(bool(row[f'seen_{key}']) for row in rows),
            'current': sum(row['current_variant'] == key for row in rows),
            'active_current': sum(row['current_variant'] == key for row in active),
            'preferred': votes[key],
            'preferred_by_cohort': {cohort: sum(row['preference'] == key and row['assigned_variant'] == cohort for row in rows) for cohort in ('a', 'b')},
        } for key in ('a', 'b')],
    }
