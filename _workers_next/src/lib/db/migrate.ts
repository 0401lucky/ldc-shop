import { drizzle } from 'drizzle-orm/d1';
import { eq, getTableName, SQL, sql } from 'drizzle-orm';
import { getTableConfig, SQLiteSyncDialect, type SQLiteColumn } from 'drizzle-orm/sqlite-core';
import type { D1Database } from '@cloudflare/workers-types';
import * as schema from './schema';
import { loginUsers, products, settings } from './schema';
import { CURRENT_SCHEMA_VERSION } from './schema-version';
import { updateProductAggregates } from './product-aggregates';

// Explicit deployment/maintenance entry point. Never import this from request handlers.
export async function migrateDatabase(d1: D1Database) {
    const db = drizzle(d1, { schema });
    const TIMESTAMP_MS_THRESHOLD = 1_000_000_000_000;

    function errorText(error: unknown): string {
        const cause = typeof error === 'object' && error && 'cause' in error ? error.cause : '';
        return (String(error) + ' ' + String(cause)).toLowerCase();
    }

    function isMissingTable(error: unknown) {
        const text = errorText(error);
        return text.includes('no such table') || text.includes('does not exist') || text.includes('42p01');
    }

    function isMissingTableOrColumn(error: unknown) {
        const text = errorText(error);
        return isMissingTable(error) || text.includes('42703') || text.includes('no such column') || text.includes('column not found') || text.includes('d1_column_notfound');
    }

    async function migrateTimestampColumnsToMs() {
        const tableColumns = [
            { table: 'products', columns: ['created_at'] },
            { table: 'cards', columns: ['reserved_at', 'used_at', 'created_at'] },
            { table: 'orders', columns: ['paid_at', 'delivered_at', 'created_at'] },
            { table: 'login_users', columns: ['created_at', 'last_login_at'] },
            { table: 'daily_checkins_v2', columns: ['created_at'] },
            { table: 'settings', columns: ['updated_at'] },
            { table: 'reviews', columns: ['created_at'] },
            { table: 'review_replies', columns: ['created_at'] },
            { table: 'categories', columns: ['created_at', 'updated_at'] },
            { table: 'refund_requests', columns: ['created_at', 'updated_at', 'processed_at'] },
            { table: 'user_notifications', columns: ['created_at'] },
            { table: 'admin_messages', columns: ['created_at'] },
            { table: 'user_messages', columns: ['created_at'] },
            { table: 'broadcast_messages', columns: ['created_at'] },
            { table: 'broadcast_reads', columns: ['created_at'] },
            { table: 'wishlist_items', columns: ['created_at'] },
            { table: 'wishlist_votes', columns: ['created_at'] },
        ];

        for (const { table, columns } of tableColumns) {
            for (const column of columns) {
                try {
                    await db.run(sql.raw(
                        `UPDATE ${table} SET ${column} = ${column} * 1000 WHERE ${column} IS NOT NULL AND ${column} < ${TIMESTAMP_MS_THRESHOLD}`
                    ));
                } catch (error: unknown) {
                    if (!isMissingTableOrColumn(error)) throw error;
                }
            }
        }
    }

    type GitHubLoginUserRow = {
        userId: string
        username: string | null
        email: string | null
        points: number
        isBlocked: boolean
        desktopNotificationsEnabled: boolean
        createdAt: Date | null
        lastLoginAt: Date | null
    }

    function toEpochMs(value: Date | number | string | null | undefined): number | null {
        if (value === null || value === undefined) return null
        if (value instanceof Date) return value.getTime()
        if (typeof value === 'number') return Number.isFinite(value) ? value : null
        const parsed = Number(value)
        return Number.isFinite(parsed) ? parsed : null
    }

    function pickCanonicalGitHubUser(rows: GitHubLoginUserRow[]) {
        const byRecentLoginDesc = [...rows].sort((a, b) => {
            const bTime = toEpochMs(b.lastLoginAt) || 0
            const aTime = toEpochMs(a.lastLoginAt) || 0
            if (bTime !== aTime) return bTime - aTime
            const aCreated = toEpochMs(a.createdAt) || 0
            const bCreated = toEpochMs(b.createdAt) || 0
            return aCreated - bCreated
        })

        const stableProviderId = byRecentLoginDesc.find((row) => /^github:\d+$/i.test(row.userId))
        if (stableProviderId) return stableProviderId

        const githubScoped = byRecentLoginDesc.find((row) => row.userId.toLowerCase().startsWith('github:'))
        if (githubScoped) return githubScoped

        return byRecentLoginDesc[0]
    }

    function normalizeGitHubUserIdValue(userId?: string | null): string | null {
        if (!userId) return null
        let normalized = userId.trim()
        while (normalized.toLowerCase().startsWith('github:')) {
            normalized = normalized.slice('github:'.length)
        }
        if (!normalized) return null
        return `github:${normalized}`
    }

    function normalizeGitHubUsernameValue(username?: string | null): string | null {
        if (!username) return null
        const normalized = username.trim().toLowerCase()
        if (!normalized) return null
        return normalized
    }

    function mergeLoginUserRows(primary: GitHubLoginUserRow, secondary: GitHubLoginUserRow) {
        const createdCandidates = [toEpochMs(primary.createdAt), toEpochMs(secondary.createdAt)].filter((value): value is number => value !== null)
        const lastLoginCandidates = [toEpochMs(primary.lastLoginAt), toEpochMs(secondary.lastLoginAt)].filter((value): value is number => value !== null)

        return {
            username: normalizeGitHubUsernameValue(primary.username) || normalizeGitHubUsernameValue(secondary.username),
            email: primary.email || secondary.email || null,
            points: Number(primary.points || 0) + Number(secondary.points || 0),
            isBlocked: !!primary.isBlocked || !!secondary.isBlocked,
            desktopNotificationsEnabled: !!primary.desktopNotificationsEnabled || !!secondary.desktopNotificationsEnabled,
            createdAt: createdCandidates.length ? new Date(Math.min(...createdCandidates)) : new Date(),
            lastLoginAt: lastLoginCandidates.length ? new Date(Math.max(...lastLoginCandidates)) : new Date(),
        }
    }

    async function runMigrationQuery(statement: SQL) {
        try {
            await db.run(statement)
        } catch (error: unknown) {
            if (!isMissingTableOrColumn(error)) throw error
        }
    }

    async function moveUserReferences(sourceUserId: string, targetUserId: string) {
        if (!sourceUserId || !targetUserId || sourceUserId === targetUserId) return

        await runMigrationQuery(sql`
            DELETE FROM broadcast_reads
            WHERE user_id = ${sourceUserId}
              AND EXISTS (
                SELECT 1
                FROM broadcast_reads br
                WHERE br.message_id = broadcast_reads.message_id
                  AND br.user_id = ${targetUserId}
              )
        `)

        await runMigrationQuery(sql`
            DELETE FROM wishlist_votes
            WHERE user_id = ${sourceUserId}
              AND EXISTS (
                SELECT 1
                FROM wishlist_votes wv
                WHERE wv.item_id = wishlist_votes.item_id
                  AND wv.user_id = ${targetUserId}
              )
        `)

        await runMigrationQuery(sql`UPDATE orders SET user_id = ${targetUserId} WHERE user_id = ${sourceUserId}`)
        await runMigrationQuery(sql`UPDATE reviews SET user_id = ${targetUserId} WHERE user_id = ${sourceUserId}`)
        await runMigrationQuery(sql`UPDATE refund_requests SET user_id = ${targetUserId} WHERE user_id = ${sourceUserId}`)
        await runMigrationQuery(sql`UPDATE daily_checkins_v2 SET user_id = ${targetUserId} WHERE user_id = ${sourceUserId}`)
        await runMigrationQuery(sql`UPDATE user_notifications SET user_id = ${targetUserId} WHERE user_id = ${sourceUserId}`)
        await runMigrationQuery(sql`UPDATE user_messages SET user_id = ${targetUserId} WHERE user_id = ${sourceUserId}`)
        await runMigrationQuery(sql`UPDATE broadcast_reads SET user_id = ${targetUserId} WHERE user_id = ${sourceUserId}`)
        await runMigrationQuery(sql`UPDATE wishlist_votes SET user_id = ${targetUserId} WHERE user_id = ${sourceUserId}`)
        await runMigrationQuery(sql`UPDATE wishlist_items SET user_id = ${targetUserId} WHERE user_id = ${sourceUserId}`)
        await runMigrationQuery(sql`UPDATE admin_messages SET target_value = ${targetUserId} WHERE target_type = 'userId' AND target_value = ${sourceUserId}`)
        await runMigrationQuery(sql`DELETE FROM login_users WHERE user_id = ${sourceUserId}`)
    }

    async function migrateMalformedGitHubUserIds() {

        const malformedRows = await db.select({
            userId: loginUsers.userId,
            username: loginUsers.username,
            email: loginUsers.email,
            points: loginUsers.points,
            isBlocked: sql<boolean>`COALESCE(${loginUsers.isBlocked}, FALSE)`,
            desktopNotificationsEnabled: sql<boolean>`COALESCE(${loginUsers.desktopNotificationsEnabled}, FALSE)`,
            createdAt: loginUsers.createdAt,
            lastLoginAt: loginUsers.lastLoginAt,
        })
            .from(loginUsers)
            .where(sql`LOWER(${loginUsers.userId}) LIKE 'github:github:%'`)

        if (!malformedRows.length) return

        for (const row of malformedRows) {
            const sourceUser: GitHubLoginUserRow = {
                userId: row.userId,
                username: row.username || null,
                email: row.email || null,
                points: Number(row.points || 0),
                isBlocked: !!row.isBlocked,
                desktopNotificationsEnabled: !!row.desktopNotificationsEnabled,
                createdAt: row.createdAt || null,
                lastLoginAt: row.lastLoginAt || null,
            }

            const targetUserId = normalizeGitHubUserIdValue(sourceUser.userId)
            if (!targetUserId || targetUserId === sourceUser.userId) continue

            const existingTargetRows = await db.select({
                userId: loginUsers.userId,
                username: loginUsers.username,
                email: loginUsers.email,
                points: loginUsers.points,
                isBlocked: sql<boolean>`COALESCE(${loginUsers.isBlocked}, FALSE)`,
                desktopNotificationsEnabled: sql<boolean>`COALESCE(${loginUsers.desktopNotificationsEnabled}, FALSE)`,
                createdAt: loginUsers.createdAt,
                lastLoginAt: loginUsers.lastLoginAt,
            })
                .from(loginUsers)
                .where(eq(loginUsers.userId, targetUserId))
                .limit(1)

            const existingTarget = existingTargetRows[0]
                ? {
                    userId: existingTargetRows[0].userId,
                    username: existingTargetRows[0].username || null,
                    email: existingTargetRows[0].email || null,
                    points: Number(existingTargetRows[0].points || 0),
                    isBlocked: !!existingTargetRows[0].isBlocked,
                    desktopNotificationsEnabled: !!existingTargetRows[0].desktopNotificationsEnabled,
                    createdAt: existingTargetRows[0].createdAt || null,
                    lastLoginAt: existingTargetRows[0].lastLoginAt || null,
                } satisfies GitHubLoginUserRow
                : null

            if (!existingTarget) {
                const createdAtMs = toEpochMs(sourceUser.createdAt) || Date.now()
                const lastLoginAtMs = toEpochMs(sourceUser.lastLoginAt) || Date.now()
                await runMigrationQuery(sql`
                    INSERT OR IGNORE INTO login_users (
                        user_id,
                        username,
                        email,
                        points,
                        is_blocked,
                        desktop_notifications_enabled,
                        created_at,
                        last_login_at
                    ) VALUES (
                        ${targetUserId},
                        NULL,
                        ${sourceUser.email},
                        ${sourceUser.points},
                        ${sourceUser.isBlocked ? 1 : 0},
                        ${sourceUser.desktopNotificationsEnabled ? 1 : 0},
                        ${createdAtMs},
                        ${lastLoginAtMs}
                    )
                `)
            } else {
                const merged = mergeLoginUserRows(existingTarget, sourceUser)
                await db.update(loginUsers)
                    .set({
                        username: merged.username,
                        email: merged.email,
                        points: merged.points,
                        isBlocked: merged.isBlocked,
                        desktopNotificationsEnabled: merged.desktopNotificationsEnabled,
                        createdAt: merged.createdAt,
                        lastLoginAt: merged.lastLoginAt,
                    })
                    .where(eq(loginUsers.userId, targetUserId))
            }

            await moveUserReferences(sourceUser.userId, targetUserId)

            const normalizedUsername = normalizeGitHubUsernameValue(sourceUser.username)
            if (normalizedUsername) {
                await runMigrationQuery(sql`
                    UPDATE login_users
                    SET username = ${normalizedUsername}
                    WHERE user_id = ${targetUserId}
                      AND (username IS NULL OR username = '' OR LOWER(username) <> ${normalizedUsername})
                `)
            }
        }
    }

    async function migrateGitHubUsersDedupAndCanonicalize() {

        const githubUsers = await db.select({
            userId: loginUsers.userId,
            username: loginUsers.username,
            email: loginUsers.email,
            points: loginUsers.points,
            isBlocked: sql<boolean>`COALESCE(${loginUsers.isBlocked}, FALSE)`,
            desktopNotificationsEnabled: sql<boolean>`COALESCE(${loginUsers.desktopNotificationsEnabled}, FALSE)`,
            createdAt: loginUsers.createdAt,
            lastLoginAt: loginUsers.lastLoginAt,
        })
            .from(loginUsers)
            .where(sql`${loginUsers.username} IS NOT NULL AND LOWER(${loginUsers.username}) LIKE 'gh_%'`)

        if (!githubUsers.length) return

        const groups = new Map<string, GitHubLoginUserRow[]>()
        for (const row of githubUsers) {
            const normalizedUsername = (row.username || '').trim().toLowerCase()
            if (!normalizedUsername.startsWith('gh_')) continue
            const list = groups.get(normalizedUsername) || []
            list.push({
                userId: row.userId,
                username: row.username,
                email: row.email || null,
                points: Number(row.points || 0),
                isBlocked: !!row.isBlocked,
                desktopNotificationsEnabled: !!row.desktopNotificationsEnabled,
                createdAt: row.createdAt || null,
                lastLoginAt: row.lastLoginAt || null,
            })
            groups.set(normalizedUsername, list)
        }

        for (const [normalizedUsername, rows] of groups.entries()) {
            if (!rows.length) continue
            const canonical = pickCanonicalGitHubUser(rows)
            if (!canonical) continue

            const mergedPoints = rows.reduce((sum, row) => sum + Number(row.points || 0), 0)
            const mergedBlocked = rows.some((row) => row.isBlocked)
            const mergedDesktopNotifications = rows.some((row) => row.desktopNotificationsEnabled)
            const mergedEmail = canonical.email || rows.map((row) => row.email).find((value) => !!value) || null

            const createdCandidates = rows.map((row) => toEpochMs(row.createdAt)).filter((value): value is number => value !== null)
            const lastLoginCandidates = rows.map((row) => toEpochMs(row.lastLoginAt)).filter((value): value is number => value !== null)

            const mergedCreatedAt = createdCandidates.length
                ? new Date(Math.min(...createdCandidates))
                : (canonical.createdAt || new Date())
            const mergedLastLoginAt = lastLoginCandidates.length
                ? new Date(Math.max(...lastLoginCandidates))
                : (canonical.lastLoginAt || new Date())

            await db.update(loginUsers)
                .set({
                    username: normalizedUsername,
                    email: mergedEmail,
                    points: mergedPoints,
                    isBlocked: mergedBlocked,
                    desktopNotificationsEnabled: mergedDesktopNotifications,
                    createdAt: mergedCreatedAt,
                    lastLoginAt: mergedLastLoginAt,
                })
                .where(eq(loginUsers.userId, canonical.userId))

            await runMigrationQuery(sql`
                UPDATE orders
                SET username = ${normalizedUsername}
                WHERE user_id = ${canonical.userId}
                  AND (username IS NULL OR LOWER(username) NOT LIKE 'gh_%')
            `)
            await runMigrationQuery(sql`
                UPDATE reviews
                SET username = ${normalizedUsername}
                WHERE user_id = ${canonical.userId}
                  AND (username IS NULL OR LOWER(username) NOT LIKE 'gh_%')
            `)
            await runMigrationQuery(sql`
                UPDATE refund_requests
                SET username = ${normalizedUsername}
                WHERE user_id = ${canonical.userId}
                  AND (username IS NULL OR LOWER(username) NOT LIKE 'gh_%')
            `)
            await runMigrationQuery(sql`
                UPDATE user_messages
                SET username = ${normalizedUsername}
                WHERE user_id = ${canonical.userId}
                  AND (username IS NULL OR LOWER(username) NOT LIKE 'gh_%')
            `)
            await runMigrationQuery(sql`
                UPDATE wishlist_items
                SET username = ${normalizedUsername}
                WHERE user_id = ${canonical.userId}
                  AND (username IS NULL OR LOWER(username) NOT LIKE 'gh_%')
            `)

            for (const row of rows) {
                if (row.userId === canonical.userId) continue
                await moveUserReferences(row.userId, canonical.userId)
            }
        }
    }

    async function isLoginUsersBackfilled(): Promise<boolean> {
        try {
            const result = await db.select({ value: settings.value })
                .from(settings)
                .where(eq(settings.key, 'login_users_backfilled'));
            return result[0]?.value === '1';
        } catch (error: unknown) {
            if (isMissingTable(error)) {
                return false;
            }
            throw error;
        }
    }

    async function markLoginUsersBackfilled() {
        await db.insert(settings).values({
            key: 'login_users_backfilled',
            value: '1',
            updatedAt: new Date()
        }).onConflictDoUpdate({
            target: settings.key,
            set: { value: '1', updatedAt: new Date() }
        });
    }

    async function backfillLoginUsersFromOrdersAndReviews() {
        const alreadyBackfilled = await isLoginUsersBackfilled();
        if (alreadyBackfilled) return;


        try {
            await db.run(sql`
                INSERT INTO login_users(user_id, username, created_at, last_login_at)
                SELECT user_id, MAX(username) AS username, (unixepoch() * 1000), (unixepoch() * 1000)
                FROM (
                    SELECT user_id, username FROM orders WHERE user_id IS NOT NULL AND user_id <> ''
                    UNION ALL
                    SELECT user_id, username FROM reviews WHERE user_id IS NOT NULL AND user_id <> ''
                )
                GROUP BY user_id
                ON CONFLICT(user_id) DO NOTHING
            `);
        } catch (error: unknown) {
            if (isMissingTable(error)) return;
            throw error;
        }

        await markLoginUsersBackfilled();
    }

    const indexStatements = [
            `CREATE INDEX IF NOT EXISTS products_active_sort_idx ON products(is_active, sort_order, created_at)`,
            `CREATE INDEX IF NOT EXISTS products_stock_count_idx ON products(stock_count)`,
            `CREATE INDEX IF NOT EXISTS products_sold_count_idx ON products(sold_count)`,
            `CREATE INDEX IF NOT EXISTS cards_product_used_reserved_idx ON cards(product_id, is_used, reserved_at)`,
            `CREATE INDEX IF NOT EXISTS cards_reserved_order_idx ON cards(reserved_order_id)`,
            `CREATE INDEX IF NOT EXISTS cards_expires_at_idx ON cards(expires_at)`,
            `CREATE INDEX IF NOT EXISTS orders_status_paid_at_idx ON orders(status, paid_at)`,
            `CREATE INDEX IF NOT EXISTS orders_status_created_at_idx ON orders(status, created_at)`,
            `CREATE INDEX IF NOT EXISTS orders_user_status_created_at_idx ON orders(user_id, status, created_at)`,
            `CREATE INDEX IF NOT EXISTS orders_product_status_idx ON orders(product_id, status)`,
            `CREATE INDEX IF NOT EXISTS reviews_product_created_at_idx ON reviews(product_id, created_at)`,
            `CREATE INDEX IF NOT EXISTS review_replies_review_created_idx ON review_replies(review_id, created_at)`,
            `CREATE INDEX IF NOT EXISTS refund_requests_order_id_idx ON refund_requests(order_id)`,
            `CREATE INDEX IF NOT EXISTS user_notifications_user_created_idx ON user_notifications(user_id, created_at)`,
            `CREATE INDEX IF NOT EXISTS user_notifications_user_read_idx ON user_notifications(user_id, is_read, created_at)`,
            `CREATE INDEX IF NOT EXISTS admin_messages_created_idx ON admin_messages(created_at)`,
            `CREATE INDEX IF NOT EXISTS user_messages_read_created_idx ON user_messages(is_read, created_at)`,
            `CREATE INDEX IF NOT EXISTS user_messages_user_created_idx ON user_messages(user_id, created_at)`,
            `CREATE INDEX IF NOT EXISTS broadcast_messages_created_idx ON broadcast_messages(created_at)`,
            `CREATE UNIQUE INDEX IF NOT EXISTS broadcast_reads_message_user_uq ON broadcast_reads(message_id, user_id)`,
            `CREATE INDEX IF NOT EXISTS broadcast_reads_user_idx ON broadcast_reads(user_id, created_at)`,
            `CREATE INDEX IF NOT EXISTS wishlist_items_created_idx ON wishlist_items(created_at)`,
            `CREATE INDEX IF NOT EXISTS wishlist_votes_item_idx ON wishlist_votes(item_id, created_at)`,
            `CREATE UNIQUE INDEX IF NOT EXISTS wishlist_votes_item_user_uq ON wishlist_votes(item_id, user_id)`,
            `CREATE UNIQUE INDEX IF NOT EXISTS login_users_github_username_uq ON login_users(lower(username)) WHERE username IS NOT NULL AND lower(username) LIKE 'gh_%'`,
        ];

    let previousVersion = 0;
    try {
        const rows = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, 'schema_version'));
        previousVersion = Number(rows[0]?.value) || 0;
    } catch (error) {
        if (!isMissingTable(error)) throw error;
    }
    if (previousVersion >= CURRENT_SCHEMA_VERSION) return { migrated: false, version: previousVersion };

    const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
    const dialect = new SQLiteSyncDialect();
    function columnDefinition(column: SQLiteColumn, creating: boolean) {
        let definition = quote(column.name) + ' ' + column.getSQLType();
        if (creating && column.primary) {
            definition += ' PRIMARY KEY';
            if ((column as SQLiteColumn & { autoIncrement?: boolean }).autoIncrement) definition += ' AUTOINCREMENT';
        }
        if (column.notNull) definition += ' NOT NULL';
        const value = column.default;
        if (value instanceof SQL) {
            definition += ' DEFAULT (' + dialect.sqlToQuery(value).sql + ')';
        } else if (typeof value === 'string') {
            definition += " DEFAULT '" + value.replaceAll("'", "''") + "'";
        } else if (typeof value === 'number' || typeof value === 'boolean') {
            definition += ' DEFAULT ' + Number(value);
        } else if (creating && column.defaultFn && column.defaultFn() instanceof Date) {
            definition += ' DEFAULT (unixepoch() * 1000)';
        }
        return definition;
    }

    for (const table of Object.values(schema)) {
        const config = getTableConfig(table);
        const definitions = config.columns.map(column => columnDefinition(column, true));
        for (const foreignKey of config.foreignKeys) {
            const reference = foreignKey.reference();
            definitions.push(
                'FOREIGN KEY (' + reference.columns.map(column => quote(column.name)).join(', ') + ')' +
                ' REFERENCES ' + quote(getTableName(reference.foreignTable)) +
                ' (' + reference.foreignColumns.map(column => quote(column.name)).join(', ') + ')' +
                ' ON DELETE ' + (foreignKey.onDelete || 'no action') + ' ON UPDATE ' + (foreignKey.onUpdate || 'no action')
            );
        }
        await db.run(sql.raw('CREATE TABLE IF NOT EXISTS ' + quote(config.name) + ' (' + definitions.join(', ') + ')'));
        const existing = await db.all<{ name: string }>(sql.raw('PRAGMA table_info(' + quote(config.name) + ')'));
        const names = new Set(existing.map(column => column.name));
        for (const column of config.columns) {
            if (names.has(column.name)) continue;
            if (column.primary) throw new Error('Missing primary key in ' + config.name + '; manual migration required');
            await db.run(sql.raw('ALTER TABLE ' + quote(config.name) + ' ADD COLUMN ' + columnDefinition(column, false)));
        }
    }

    await backfillLoginUsersFromOrdersAndReviews();
    if (previousVersion < 21) {
        await migrateTimestampColumnsToMs();
        await migrateMalformedGitHubUserIds();
        await migrateGitHubUsersDedupAndCanonicalize();
    }
    await db.run(sql`DROP INDEX IF EXISTS cards_product_id_card_key_uq`);
    await db.run(sql`DELETE FROM broadcast_reads WHERE id NOT IN (SELECT MIN(id) FROM broadcast_reads GROUP BY message_id, user_id)`);
    for (const statement of indexStatements) await db.run(sql.raw(statement));
    await db.run(sql`CREATE UNIQUE INDEX IF NOT EXISTS categories_name_uq ON categories(name)`);
    await db.run(sql`CREATE INDEX IF NOT EXISTS cards_unused_stock_idx ON cards(product_id, expires_at, reserved_at) WHERE COALESCE(is_used, 0) = 0`);

    const backfilled = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, 'product_aggregates_backfilled_v2'));
    if (backfilled[0]?.value !== '1') {
        const rows = await db.select({ id: products.id }).from(products);
        await updateProductAggregates(db, rows.map(row => row.id));
        await db.insert(settings).values({ key: 'product_aggregates_backfilled_v2', value: '1', updatedAt: new Date() })
            .onConflictDoUpdate({ target: settings.key, set: { value: '1', updatedAt: new Date() } });
    }
    await db.insert(settings).values({ key: 'schema_version', value: String(CURRENT_SCHEMA_VERSION), updatedAt: new Date() })
        .onConflictDoUpdate({ target: settings.key, set: { value: String(CURRENT_SCHEMA_VERSION), updatedAt: new Date() } });
    return { migrated: true, version: CURRENT_SCHEMA_VERSION };
}
