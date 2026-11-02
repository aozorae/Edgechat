export function createD1Adapter(database) {
  let batchTail = Promise.resolve();
	function prepare(sql, bindings = []) {
    return {
      bind(...values) {
				return prepare(sql, values);
      },
      async all() {
        const statement = database.prepare(sql);
        statement.bind(bindings);
        const results = [];
        while (statement.step()) {
          results.push(statement.getAsObject());
        }
        statement.free();
        return { results };
      },
      async first(column) {
        const { results } = await this.all();
        return column ? results[0]?.[column] ?? null : results[0] ?? null;
      },
      async run() {
        const statement = database.prepare(sql);
        statement.bind(bindings);
        const results = [];
        while (statement.step()) results.push(statement.getAsObject());
        statement.free();
        const changes = database.getRowsModified();
        const lastRow = database.exec('SELECT last_insert_rowid() AS id');
        const lastRowId = Number(lastRow[0]?.values?.[0]?.[0] || 0);
        return { results, meta: { changes, last_row_id: lastRowId } };
      }
    };
  }

  return {
    prepare,
    batch(statements) {
      // 与 D1 一样串行执行事务，避免并发发送测试在同一个 SQLite 连接中嵌套 BEGIN。
      const pending = batchTail.then(async () => {
        database.run('BEGIN');
        try {
          const results = [];
          for (const statement of statements) {
            results.push(await statement.run());
          }
          database.run('COMMIT');
          return results;
        } catch (error) {
          database.run('ROLLBACK');
          throw error;
        }
      });
      batchTail = pending.catch(() => {});
      return pending;
    }
  };
}

export function createKvAdapter() {
  const values = new Map();
  return {
    values,
    async get(key) {
      return values.get(String(key)) ?? null;
    },
    async put(key, value) {
      values.set(String(key), String(value));
    },
    async delete(key) {
      values.delete(String(key));
    }
  };
}
