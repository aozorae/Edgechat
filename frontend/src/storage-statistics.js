export { formatByteSize } from './file-size.ts';

export function storageTimestampValue(value) {
  if (value === null || value === undefined || value === '') return 0;
  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

export function formatStorageDateTime(value) {
  const timestamp = storageTimestampValue(value);
  return timestamp ? formatDateTime(timestamp) : '';
}

export function mergeStorageSummary(target, items = []) {
  for (const item of items) {
    const current = target.get(item.ownerKey) || {
      ownerKey: item.ownerKey,
      ownerType: item.ownerType,
      ownerId: item.ownerId,
      objectCount: 0,
      bytes: 0,
      latestUploadedAt: null
    };
    current.objectCount += Number(item.objectCount) || 0;
    current.bytes += Number(item.bytes) || 0;
    if (
      storageTimestampValue(item.latestUploadedAt) >
      storageTimestampValue(current.latestUploadedAt)
    ) {
      current.latestUploadedAt = item.latestUploadedAt;
    }
    target.set(item.ownerKey, current);
  }
  return target;
}

export function buildStorageRows(users = [], summaries = new Map()) {
  const usersById = new Map(users.map((user) => [Number(user.id), user]));
  const rows = users
    .filter((user) => !user.isDeleted)
    .map((user) => storageUserRow(user, summaries.get(`user:${Number(user.id)}`)));

  for (const summary of summaries.values()) {
    if (summary.ownerType === 'user') {
      const user = usersById.get(Number(summary.ownerId));
      if (user?.isDeleted) {
        rows.push(storageUserRow(user, summary));
      } else if (!user) {
        rows.push({
          ...storageValues(summary),
          ownerKey: summary.ownerKey,
          displayName: t('storage.unknownUser', { id: summary.ownerId }),
          username: '',
          isDeleted: true
        });
      }
      continue;
    }

    rows.push({
      ...storageValues(summary),
      ownerKey: summary.ownerKey,
      displayName:
        summary.ownerType === 'telegram'
          ? t('storage.systemTelegram')
          : t('storage.unknownHistorical'),
      username: '',
      isDeleted: false
    });
  }

  const totalBytes = rows.reduce((total, row) => total + row.bytes, 0);
  return rows.map((row) => ({
    ...row,
    share: totalBytes > 0 ? row.bytes / totalBytes : 0
  }));
}

function storageValues(summary) {
  return {
    objectCount: Number(summary?.objectCount) || 0,
    bytes: Number(summary?.bytes) || 0,
    latestUploadedAt: summary?.latestUploadedAt || null
  };
}

function storageUserRow(user, summary) {
  return {
    ...storageValues(summary),
    ownerKey: `user:${Number(user.id)}`,
    displayName: user.displayName,
    username: user.username,
    isDeleted: Boolean(user.isDeleted)
  };
}

export function sortStorageRows(rows, sort) {
  const direction = sort.direction === 'asc' ? 1 : -1;
  return [...rows].sort((left, right) => {
    if (sort.key === 'latestUploadedAt') {
      const leftTime = storageTimestampValue(left.latestUploadedAt);
      const rightTime = storageTimestampValue(right.latestUploadedAt);
      if (!leftTime && !rightTime) return compareNames(left, right);
      if (!leftTime) return 1;
      if (!rightTime) return -1;
      return (leftTime - rightTime) * direction || compareNames(left, right);
    }

    const difference = (Number(left[sort.key]) || 0) - (Number(right[sort.key]) || 0);
    return difference * direction || compareNames(left, right);
  });
}

function compareNames(left, right) {
  return compareLocalized(left.displayName, right.displayName);
}
import { compareLocalized, formatDateTime, t } from './i18n.js';
