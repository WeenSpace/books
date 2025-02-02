import {
  CannotCommitError,
  getDbError,
  NotFoundError,
  ValueError,
} from 'fyo/utils/errors';
import { knex, Knex } from 'knex';
import {
  Field,
  FieldTypeEnum,
  RawValue,
  Schema,
  SchemaMap,
  TargetField,
} from '../../schemas/types';
import {
  getIsNullOrUndef,
  getRandomString,
  getValueMapFromList,
} from '../../utils';
import { DatabaseBase, GetAllOptions, QueryFilter } from '../../utils/db/types';
import { getDefaultMetaFieldValueMap, sqliteTypeMap, SYSTEM } from '../helpers';
import {
  ColumnDiff,
  FieldValueMap,
  GetQueryBuilderOptions,
  SingleValue,
} from './types';

/**
 * # DatabaseCore
 * This is the ORM, the DatabaseCore interface (function signatures) should be
 * replicated by the frontend demuxes and all the backend muxes.
 *
 * ## Db Core Call Sequence
 *
 * 1. Init core: `const db = new DatabaseCore(dbPath)`.
 * 2. Connect db: `db.connect()`. This will allow for raw queries to be executed.
 * 3. Set schemas: `db.setSchemaMap(schemaMap)`. This will allow for ORM functions to be executed.
 * 4. Migrate: `await db.migrate()`. This will create absent tables and update the tables' shape.
 * 5. ORM function execution: `db.get(...)`, `db.insert(...)`, etc.
 * 6. Close connection: `await db.close()`.
 *
 * Note: Meta values: created, modified, createdBy, modifiedBy are set by DatabaseCore
 * only for schemas that are SingleValue. Else they have to be passed by the caller in
 * the `fieldValueMap`.
 */

export default class DatabaseCore extends DatabaseBase {
  knex?: Knex;
  typeMap = sqliteTypeMap;
  dbPath: string;
  schemaMap: SchemaMap = {};
  connectionParams: Knex.Config;

  constructor(dbPath?: string) {
    super();
    this.dbPath = dbPath ?? ':memory:';
    this.connectionParams = {
      client: 'better-sqlite3',
      connection: {
        filename: this.dbPath,
      },
      useNullAsDefault: true,
      asyncStackTraces: process.env.NODE_ENV === 'development',
    };
  }

  static async getCountryCode(dbPath: string): Promise<string> {
    let countryCode = 'in';
    const db = new DatabaseCore(dbPath);
    await db.connect();

    let query: { value: string }[] = [];
    try {
      query = await db.knex!('SingleValue').where({
        fieldname: 'countryCode',
        parent: 'SystemSettings',
      });
    } catch {
      // Database not inialized and no countryCode passed
    }

    if (query.length > 0) {
      countryCode = query[0].value as string;
    }

    await db.close();
    return countryCode;
  }

  setSchemaMap(schemaMap: SchemaMap) {
    this.schemaMap = schemaMap;
  }

  async connect() {
    this.knex = knex(this.connectionParams);
    this.knex.on('query-error', (error) => {
      error.type = getDbError(error);
    });
    await this.knex.raw('PRAGMA foreign_keys=ON');
  }

  async close() {
    await this.knex!.destroy();
  }

  async commit() {
    /**
     * this auto commits, commit is not required
     * will later wrap the outermost functions in
     * transactions.
     */
    try {
      // await this.knex!.raw('commit');
    } catch (err) {
      const type = getDbError(err as Error);
      if (type !== CannotCommitError) {
        throw err;
      }
    }
  }

  async migrate() {
    for (const schemaName in this.schemaMap) {
      const schema = this.schemaMap[schemaName] as Schema;
      if (schema.isSingle) {
        continue;
      }

      if (await this.#tableExists(schemaName)) {
        await this.#alterTable(schemaName);
      } else {
        await this.#createTable(schemaName);
      }
    }

    await this.commit();
    await this.#initializeSingles();
  }

  async exists(schemaName: string, name?: string): Promise<boolean> {
    const schema = this.schemaMap[schemaName] as Schema;
    if (schema.isSingle) {
      return this.#singleExists(schemaName);
    }

    let row = [];
    try {
      const qb = this.knex!(schemaName);
      if (name !== undefined) {
        qb.where({ name });
      }
      row = await qb.limit(1);
    } catch (err) {
      if (getDbError(err as Error) !== NotFoundError) {
        throw err;
      }
    }
    return row.length > 0;
  }

  async insert(
    schemaName: string,
    fieldValueMap: FieldValueMap
  ): Promise<FieldValueMap> {
    // insert parent
    if (this.schemaMap[schemaName]!.isSingle) {
      await this.#updateSingleValues(schemaName, fieldValueMap);
    } else {
      await this.#insertOne(schemaName, fieldValueMap);
    }

    // insert children
    await this.#insertOrUpdateChildren(schemaName, fieldValueMap, false);
    return fieldValueMap;
  }

  async get(
    schemaName: string,
    name: string = '',
    fields?: string | string[]
  ): Promise<FieldValueMap> {
    const schema = this.schemaMap[schemaName] as Schema;
    if (!schema.isSingle && !name) {
      throw new ValueError('name is mandatory');
    }

    /**
     * If schema is single return all the values
     * of the single type schema, in this case field
     * is ignored.
     */
    let fieldValueMap: FieldValueMap = {};
    if (schema.isSingle) {
      return await this.#getSingle(schemaName);
    }

    if (typeof fields === 'string') {
      fields = [fields];
    }

    if (fields === undefined) {
      fields = schema.fields.map((f) => f.fieldname);
    }

    /**
     * Separate table fields and non table fields
     */
    const allTableFields: TargetField[] = this.#getTableFields(schemaName);
    const allTableFieldNames: string[] = allTableFields.map((f) => f.fieldname);
    const tableFields: TargetField[] = allTableFields.filter((f) =>
      fields!.includes(f.fieldname)
    );
    const nonTableFieldNames: string[] = fields.filter(
      (f) => !allTableFieldNames.includes(f)
    );

    /**
     * If schema is not single then return specific fields
     * if child fields are selected, all child fields are returned.
     */
    if (nonTableFieldNames.length) {
      fieldValueMap =
        (await this.#getOne(schemaName, name, nonTableFieldNames)) ?? {};
    }

    if (tableFields.length) {
      await this.#loadChildren(name, fieldValueMap, tableFields);
    }
    return fieldValueMap;
  }

  async getAll(
    schemaName: string,
    options: GetAllOptions = {}
  ): Promise<FieldValueMap[]> {
    const schema = this.schemaMap[schemaName] as Schema;
    if (schema === undefined) {
      throw new NotFoundError(`schema ${schemaName} not found`);
    }

    const hasCreated = !!schema.fields.find((f) => f.fieldname === 'created');

    const {
      fields = ['name'],
      filters,
      offset,
      limit,
      groupBy,
      orderBy = hasCreated ? 'created' : undefined,
      order = 'desc',
    } = options;

    return (await this.#getQueryBuilder(
      schemaName,
      typeof fields === 'string' ? [fields] : fields,
      filters ?? {},
      {
        offset,
        limit,
        groupBy,
        orderBy,
        order,
      }
    )) as FieldValueMap[];
  }

  async getSingleValues(
    ...fieldnames: ({ fieldname: string; parent?: string } | string)[]
  ): Promise<SingleValue<RawValue>> {
    const fieldnameList = fieldnames.map((fieldname) => {
      if (typeof fieldname === 'string') {
        return { fieldname };
      }
      return fieldname;
    });

    let builder = this.knex!('SingleValue');
    builder = builder.where(fieldnameList[0]);

    fieldnameList.slice(1).forEach(({ fieldname, parent }) => {
      if (typeof parent === 'undefined') {
        builder = builder.orWhere({ fieldname });
      } else {
        builder = builder.orWhere({ fieldname, parent });
      }
    });

    let values: { fieldname: string; parent: string; value: RawValue }[] = [];
    try {
      values = await builder.select('fieldname', 'value', 'parent');
    } catch (err) {
      if (getDbError(err as Error) === NotFoundError) {
        return [];
      }

      throw err;
    }

    return values;
  }

  async rename(schemaName: string, oldName: string, newName: string) {
    /**
     * Rename is expensive mostly won't allow it.
     * TODO: rename all links
     * TODO: rename in childtables
     */
    await this.knex!(schemaName)
      .update({ name: newName })
      .where('name', oldName);
    await this.commit();
  }

  async update(schemaName: string, fieldValueMap: FieldValueMap) {
    // update parent
    if (this.schemaMap[schemaName]!.isSingle) {
      await this.#updateSingleValues(schemaName, fieldValueMap);
    } else {
      await this.#updateOne(schemaName, fieldValueMap);
    }

    // insert or update children
    await this.#insertOrUpdateChildren(schemaName, fieldValueMap, true);
  }

  async delete(schemaName: string, name: string) {
    const schema = this.schemaMap[schemaName] as Schema;
    if (schema.isSingle) {
      await this.#deleteSingle(schemaName, name);
      return;
    }

    await this.#deleteOne(schemaName, name);

    // delete children
    const tableFields = this.#getTableFields(schemaName);

    for (const field of tableFields) {
      await this.#deleteChildren(field.target, name);
    }
  }

  async #tableExists(schemaName: string) {
    return await this.knex!.schema.hasTable(schemaName);
  }

  async #singleExists(singleSchemaName: string) {
    const res = await this.knex!('SingleValue')
      .count('parent as count')
      .where('parent', singleSchemaName)
      .first();
    return (res?.count ?? 0) > 0;
  }

  async #removeColumns(schemaName: string, targetColumns: string[]) {
    const fields = this.schemaMap[schemaName]?.fields
      .filter((f) => f.fieldtype !== FieldTypeEnum.Table)
      .map((f) => f.fieldname);
    const tableRows = await this.getAll(schemaName, { fields });
    this.prestigeTheTable(schemaName, tableRows);
  }

  async prestigeTheTable(schemaName: string, tableRows: FieldValueMap[]) {
    const max = 200;

    // Alter table hacx for sqlite in case of schema change.
    const tempName = `__${schemaName}`;
    await this.knex!.schema.dropTableIfExists(tempName);

    await this.knex!.raw('PRAGMA foreign_keys=OFF');
    await this.#createTable(schemaName, tempName);

    if (tableRows.length > 200) {
      const fi = Math.floor(tableRows.length / max);
      for (let i = 0; i <= fi; i++) {
        const rowSlice = tableRows.slice(i * max, i + 1 * max);
        if (rowSlice.length === 0) {
          break;
        }
        await this.knex!.batchInsert(tempName, rowSlice);
      }
    } else {
      await this.knex!.batchInsert(tempName, tableRows);
    }

    await this.knex!.schema.dropTable(schemaName);
    await this.knex!.schema.renameTable(tempName, schemaName);
    await this.knex!.raw('PRAGMA foreign_keys=ON');
  }

  async #getTableColumns(schemaName: string): Promise<string[]> {
    const info: FieldValueMap[] = await this.knex!.raw(
      `PRAGMA table_info(${schemaName})`
    );
    return info.map((d) => d.name as string);
  }

  async truncate(tableNames?: string[]) {
    if (tableNames === undefined) {
      const q = (await this.knex!.raw(`
        select name from sqlite_schema
        where type='table'
        and name not like 'sqlite_%'`)) as { name: string }[];
      tableNames = q.map((i) => i.name);
    }

    for (const name of tableNames) {
      await this.knex!(name).del();
    }
  }

  async #getForeignKeys(schemaName: string): Promise<string[]> {
    const foreignKeyList: FieldValueMap[] = await this.knex!.raw(
      `PRAGMA foreign_key_list(${schemaName})`
    );
    return foreignKeyList.map((d) => d.from as string);
  }

  #getQueryBuilder(
    schemaName: string,
    fields: string[],
    filters: QueryFilter,
    options: GetQueryBuilderOptions
  ): Knex.QueryBuilder {
    const builder = this.knex!.select(fields).from(schemaName);

    this.#applyFiltersToBuilder(builder, filters);

    if (options.orderBy) {
      builder.orderBy(options.orderBy, options.order);
    }

    if (options.groupBy) {
      builder.groupBy(options.groupBy);
    }

    if (options.offset) {
      builder.offset(options.offset);
    }

    if (options.limit) {
      builder.limit(options.limit);
    }

    return builder;
  }

  #applyFiltersToBuilder(builder: Knex.QueryBuilder, filters: QueryFilter) {
    // {"status": "Open"} => `status = "Open"`

    // {"status": "Open", "name": ["like", "apple%"]}
    // => `status="Open" and name like "apple%"

    // {"date": [">=", "2017-09-09", "<=", "2017-11-01"]}
    // => `date >= 2017-09-09 and date <= 2017-11-01`

    const filtersArray = [];

    for (const field in filters) {
      const value = filters[field];
      let operator: string | number = '=';
      let comparisonValue = value as string | number | (string | number)[];

      if (Array.isArray(value)) {
        operator = (value[0] as string).toLowerCase();
        comparisonValue = value[1] as string | number | (string | number)[];

        if (operator === 'includes') {
          operator = 'like';
        }

        if (
          operator === 'like' &&
          !(comparisonValue as (string | number)[]).includes('%')
        ) {
          comparisonValue = `%${comparisonValue}%`;
        }
      }

      filtersArray.push([field, operator, comparisonValue]);

      if (Array.isArray(value) && value.length > 2) {
        // multiple conditions
        const operator = value[2];
        const comparisonValue = value[3];
        filtersArray.push([field, operator, comparisonValue]);
      }
    }

    filtersArray.map((filter) => {
      const field = filter[0] as string;
      const operator = filter[1];
      const comparisonValue = filter[2];

      if (operator === '=') {
        builder.where(field, comparisonValue);
      } else {
        builder.where(field, operator as string, comparisonValue as string);
      }
    });
  }

  async #getColumnDiff(schemaName: string): Promise<ColumnDiff> {
    const tableColumns = await this.#getTableColumns(schemaName);
    const validFields = this.schemaMap[schemaName]!.fields;
    const diff: ColumnDiff = { added: [], removed: [] };

    for (const field of validFields) {
      const hasDbType = this.typeMap.hasOwnProperty(field.fieldtype);
      if (!tableColumns.includes(field.fieldname) && hasDbType) {
        diff.added.push(field);
      }
    }

    const validFieldNames = validFields.map((field) => field.fieldname);
    for (const column of tableColumns) {
      if (!validFieldNames.includes(column)) {
        diff.removed.push(column);
      }
    }

    return diff;
  }

  async #getNewForeignKeys(schemaName: string): Promise<Field[]> {
    const foreignKeys = await this.#getForeignKeys(schemaName);
    const newForeignKeys: Field[] = [];
    const schema = this.schemaMap[schemaName] as Schema;
    for (const field of schema.fields) {
      if (
        field.fieldtype === 'Link' &&
        !foreignKeys.includes(field.fieldname)
      ) {
        newForeignKeys.push(field);
      }
    }
    return newForeignKeys;
  }

  #buildColumnForTable(table: Knex.AlterTableBuilder, field: Field) {
    if (field.fieldtype === FieldTypeEnum.Table) {
      // In case columnType is "Table"
      // childTable links are handled using the childTable's "parent" field
      return;
    }

    const columnType = this.typeMap[field.fieldtype];
    if (!columnType) {
      return;
    }

    const column = table[columnType](
      field.fieldname
    ) as Knex.SqlLiteColumnBuilder;

    // primary key
    if (field.fieldname === 'name') {
      column.primary();
    }

    // iefault value
    if (field.default !== undefined) {
      column.defaultTo(field.default);
    }

    // required
    if (field.required) {
      column.notNullable();
    }

    // link
    if (
      field.fieldtype === FieldTypeEnum.Link &&
      (field as TargetField).target
    ) {
      const targetSchemaName = (field as TargetField).target as string;
      const schema = this.schemaMap[targetSchemaName] as Schema;
      table
        .foreign(field.fieldname)
        .references('name')
        .inTable(schema.name)
        .onUpdate('CASCADE')
        .onDelete('RESTRICT');
    }
  }

  async #alterTable(schemaName: string) {
    // get columns
    const diff: ColumnDiff = await this.#getColumnDiff(schemaName);
    const newForeignKeys: Field[] = await this.#getNewForeignKeys(schemaName);

    return this.knex!.schema.table(schemaName, (table) => {
      if (diff.added.length) {
        for (const field of diff.added) {
          this.#buildColumnForTable(table, field);
        }
      }

      if (diff.removed.length) {
        this.#removeColumns(schemaName, diff.removed);
      }
    }).then(() => {
      if (newForeignKeys.length) {
        return this.#addForeignKeys(schemaName, newForeignKeys);
      }
    });
  }

  async #createTable(schemaName: string, tableName?: string) {
    tableName ??= schemaName;
    const fields = this.schemaMap[schemaName]!.fields;
    return await this.#runCreateTableQuery(tableName, fields);
  }

  #runCreateTableQuery(schemaName: string, fields: Field[]) {
    return this.knex!.schema.createTable(schemaName, (table) => {
      for (const field of fields) {
        this.#buildColumnForTable(table, field);
      }
    });
  }

  async #getNonExtantSingleValues(singleSchemaName: string) {
    const existingFields = (
      await this.knex!('SingleValue')
        .where({ parent: singleSchemaName })
        .select('fieldname')
    ).map(({ fieldname }) => fieldname);

    return this.schemaMap[singleSchemaName]!.fields.map(
      ({ fieldname, default: value }) => ({
        fieldname,
        value: value as RawValue | undefined,
      })
    ).filter(
      ({ fieldname, value }) =>
        !existingFields.includes(fieldname) && value !== undefined
    );
  }

  async #deleteOne(schemaName: string, name: string) {
    return await this.knex!(schemaName).where('name', name).delete();
  }

  async #deleteSingle(schemaName: string, fieldname: string) {
    return await this.knex!('SingleValue')
      .where({ parent: schemaName, fieldname })
      .delete();
  }

  #deleteChildren(schemaName: string, parentName: string) {
    return this.knex!(schemaName).where('parent', parentName).delete();
  }

  #runDeleteOtherChildren(
    field: TargetField,
    parentName: string,
    added: string[]
  ) {
    // delete other children
    return this.knex!(field.target)
      .where('parent', parentName)
      .andWhere('name', 'not in', added)
      .delete();
  }

  #prepareChild(
    parentSchemaName: string,
    parentName: string,
    child: FieldValueMap,
    field: Field,
    idx: number
  ) {
    if (!child.name) {
      child.name ??= getRandomString();
    }
    child.parent = parentName;
    child.parentSchemaName = parentSchemaName;
    child.parentFieldname = field.fieldname;
    child.idx ??= idx;
  }

  async #addForeignKeys(schemaName: string, newForeignKeys: Field[]) {
    await this.knex!.raw('PRAGMA foreign_keys=OFF');
    await this.knex!.raw('BEGIN TRANSACTION');

    const tempName = 'TEMP' + schemaName;

    // create temp table
    await this.#createTable(schemaName, tempName);

    try {
      // copy from old to new table
      await this.knex!(tempName).insert(this.knex!.select().from(schemaName));
    } catch (err) {
      await this.knex!.raw('ROLLBACK');
      await this.knex!.raw('PRAGMA foreign_keys=ON');

      const rows = await this.knex!.select().from(schemaName);
      await this.prestigeTheTable(schemaName, rows);
      return;
    }

    // drop old table
    await this.knex!.schema.dropTable(schemaName);

    // rename new table
    await this.knex!.schema.renameTable(tempName, schemaName);

    await this.knex!.raw('COMMIT');
    await this.knex!.raw('PRAGMA foreign_keys=ON');
  }

  async #loadChildren(
    parentName: string,
    fieldValueMap: FieldValueMap,
    tableFields: TargetField[]
  ) {
    for (const field of tableFields) {
      fieldValueMap[field.fieldname] = await this.getAll(field.target, {
        fields: ['*'],
        filters: { parent: parentName },
        orderBy: 'idx',
        order: 'asc',
      });
    }
  }

  async #getOne(schemaName: string, name: string, fields: string[]) {
    const fieldValueMap: FieldValueMap = await this.knex!.select(fields)
      .from(schemaName)
      .where('name', name)
      .first();
    return fieldValueMap;
  }

  async #getSingle(schemaName: string): Promise<FieldValueMap> {
    const values = await this.getAll('SingleValue', {
      fields: ['fieldname', 'value'],
      filters: { parent: schemaName },
      orderBy: 'fieldname',
      order: 'asc',
    });

    return getValueMapFromList(values, 'fieldname', 'value') as FieldValueMap;
  }

  #insertOne(schemaName: string, fieldValueMap: FieldValueMap) {
    if (!fieldValueMap.name) {
      fieldValueMap.name = getRandomString();
    }

    // Non Table Fields
    const fields = this.schemaMap[schemaName]!.fields.filter(
      (f) => f.fieldtype !== FieldTypeEnum.Table
    );

    const validMap: FieldValueMap = {};
    for (const { fieldname } of fields) {
      validMap[fieldname] = fieldValueMap[fieldname];
    }

    return this.knex!(schemaName).insert(validMap);
  }

  async #updateSingleValues(
    singleSchemaName: string,
    fieldValueMap: FieldValueMap
  ) {
    const fields = this.schemaMap[singleSchemaName]!.fields;

    for (const field of fields) {
      const value = fieldValueMap[field.fieldname] as RawValue | undefined;
      if (value === undefined) {
        continue;
      }

      await this.#updateSingleValue(singleSchemaName, field.fieldname, value);
    }
  }

  async #updateSingleValue(
    singleSchemaName: string,
    fieldname: string,
    value: RawValue
  ) {
    const updateKey = {
      parent: singleSchemaName,
      fieldname,
    };

    const names: { name: string }[] = await this.knex!('SingleValue')
      .select('name')
      .where(updateKey);

    if (!names?.length) {
      this.#insertSingleValue(singleSchemaName, fieldname, value);
    } else {
      return await this.knex!('SingleValue').where(updateKey).update({
        value,
        modifiedBy: SYSTEM,
        modified: new Date().toISOString(),
      });
    }
  }

  async #insertSingleValue(
    singleSchemaName: string,
    fieldname: string,
    value: RawValue
  ) {
    const updateMap = getDefaultMetaFieldValueMap();
    const fieldValueMap: FieldValueMap = Object.assign({}, updateMap, {
      parent: singleSchemaName,
      fieldname,
      value,
      name: getRandomString(),
    });
    return await this.knex!('SingleValue').insert(fieldValueMap);
  }

  async #initializeSingles() {
    const singleSchemaNames = Object.keys(this.schemaMap).filter(
      (n) => this.schemaMap[n]!.isSingle
    );

    for (const schemaName of singleSchemaNames) {
      if (await this.#singleExists(schemaName)) {
        await this.#updateNonExtantSingleValues(schemaName);
        continue;
      }

      const fields = this.schemaMap[schemaName]!.fields;
      if (fields.every((f) => f.default === undefined)) {
        continue;
      }

      const defaultValues: FieldValueMap = fields.reduce((acc, f) => {
        if (f.default !== undefined) {
          acc[f.fieldname] = f.default;
        }

        return acc;
      }, {} as FieldValueMap);

      await this.#updateSingleValues(schemaName, defaultValues);
    }
  }

  async #updateNonExtantSingleValues(schemaName: string) {
    const singleValues = await this.#getNonExtantSingleValues(schemaName);
    for (const sv of singleValues) {
      await this.#updateSingleValue(schemaName, sv.fieldname, sv.value!);
    }
  }

  async #updateOne(schemaName: string, fieldValueMap: FieldValueMap) {
    const updateMap = { ...fieldValueMap };
    delete updateMap.name;
    const schema = this.schemaMap[schemaName] as Schema;
    for (const { fieldname, fieldtype } of schema.fields) {
      if (fieldtype !== FieldTypeEnum.Table) {
        continue;
      }

      delete updateMap[fieldname];
    }

    if (Object.keys(updateMap).length === 0) {
      return;
    }

    return await this.knex!(schemaName)
      .where('name', fieldValueMap.name as string)
      .update(updateMap);
  }

  async #insertOrUpdateChildren(
    schemaName: string,
    fieldValueMap: FieldValueMap,
    isUpdate: boolean
  ) {
    const parentName = fieldValueMap.name as string;
    const tableFields = this.#getTableFields(schemaName);

    for (const field of tableFields) {
      const added: string[] = [];

      const tableFieldValue = fieldValueMap[field.fieldname] as
        | FieldValueMap[]
        | undefined
        | null;
      if (getIsNullOrUndef(tableFieldValue)) {
        continue;
      }

      for (const child of tableFieldValue!) {
        this.#prepareChild(schemaName, parentName, child, field, added.length);

        if (
          isUpdate &&
          (await this.exists(field.target, child.name as string))
        ) {
          await this.#updateOne(field.target, child);
        } else {
          await this.#insertOne(field.target, child);
        }

        added.push(child.name as string);
      }

      if (isUpdate) {
        await this.#runDeleteOtherChildren(field, parentName, added);
      }
    }
  }

  #getTableFields(schemaName: string): TargetField[] {
    return this.schemaMap[schemaName]!.fields.filter(
      (f) => f.fieldtype === FieldTypeEnum.Table
    ) as TargetField[];
  }
}
