import {
  CATEGORY_TYPES,
  InventoryIdSchema,
  WEBHOOK_PROVIDERS,
  type CoreInventoryResource,
} from '@kestrel-it/shared';
import type { PgTable } from 'drizzle-orm/pg-core';
import { z, type ZodRawShape } from 'zod';
import {
  categories,
  companies,
  departments,
  groups,
  locations,
  manufacturers,
  statusLabels,
  suppliers,
  users,
} from '../../db/schema/index.js';

const name = z.string().trim().min(1).max(255);
const text = (limit = 255) => z.string().trim().max(limit).nullable().optional();
const flag = z.boolean().optional();
const ref = z
  .union([InventoryIdSchema, z.literal(0).transform(() => null)])
  .nullable()
  .optional();
const ids = z.array(InventoryIdSchema).max(100).optional();
const common = { name, notes: text(10_000) };
const tags = { image: text(), tag_color: text(20) };
const address = {
  address: text(),
  address2: text(),
  city: text(100),
  state: text(100),
  country: text(100),
  zip: text(20),
  phone: text(50),
  fax: text(50),
};
const permissions = z.record(z.union([z.literal(-1), z.literal(0), z.literal(1)])).optional();

interface DirectoryDefinition {
  table: PgTable;
  nameKey: 'name' | 'username';
  shape: ZodRawShape;
  references?: Record<string, CoreInventoryResource>;
}

export const companyWebhookFields = {
  webhook_selected: z.enum(WEBHOOK_PROVIDERS).nullable().optional(),
  webhook_endpoint: z
    .string()
    .trim()
    .url()
    .max(500)
    .refine((value) => /^https?:\/\//i.test(value), 'Enter an HTTP or HTTPS URL')
    .nullable()
    .optional(),
  webhook_channel: text(),
  webhook_botname: text(),
};

export const directoryDefinitions: Record<CoreInventoryResource, DirectoryDefinition> = {
  companies: {
    table: companies,
    nameKey: 'name',
    shape: {
      ...common,
      ...tags,
      ...companyWebhookFields,
      parent_id: ref,
      fax: text(50),
      phone: text(50),
      email: text(150),
    },
    references: { parent_id: 'companies' },
  },
  groups: {
    table: groups,
    nameKey: 'name',
    shape: { ...common, permissions },
  },
  users: {
    table: users,
    nameKey: 'username',
    shape: {
      username: name,
      first_name: text(),
      last_name: text(),
      display_name: text(),
      email: z.string().trim().email().max(255).nullable().optional(),
      employee_num: text(),
      jobtitle: text(),
      phone: text(50),
      mobile: text(50),
      notes: text(10_000),
      locale: z.string().trim().min(1).max(20).optional(),
      manager_id: ref,
      location_id: ref,
      department_id: ref,
      activated: flag,
      permissions,
      company_ids: ids,
      group_ids: ids,
      password: z.string().min(10).max(255).optional(),
    },
    references: { manager_id: 'users', location_id: 'locations', department_id: 'departments' },
  },
  locations: {
    table: locations,
    nameKey: 'name',
    shape: {
      ...common,
      ...address,
      ...tags,
      parent_id: ref,
      manager_id: ref,
      company_id: ref,
      currency: text(10),
    },
    references: { parent_id: 'locations', manager_id: 'users', company_id: 'companies' },
  },
  departments: {
    table: departments,
    nameKey: 'name',
    shape: {
      ...common,
      ...tags,
      company_id: ref,
      location_id: ref,
      manager_id: ref,
      phone: text(50),
      fax: text(50),
    },
    references: { company_id: 'companies', location_id: 'locations', manager_id: 'users' },
  },
  categories: {
    table: categories,
    nameKey: 'name',
    shape: {
      ...common,
      ...tags,
      category_type: z.enum(CATEGORY_TYPES),
      eula_text: text(50_000),
      use_default_eula: flag,
      require_acceptance: flag,
      alert_on_response: flag,
      checkin_email: flag,
    },
  },
  manufacturers: {
    table: manufacturers,
    nameKey: 'name',
    shape: {
      ...common,
      ...tags,
      url: text(500),
      support_url: text(500),
      warranty_lookup_url: text(500),
      support_phone: text(50),
      support_email: text(),
    },
  },
  suppliers: {
    table: suppliers,
    nameKey: 'name',
    shape: { ...common, ...address, ...tags, contact: text(), email: text(), url: text(500) },
  },
  statuslabels: {
    table: statusLabels,
    nameKey: 'name',
    shape: {
      ...common,
      color: text(20),
      deployable: flag,
      pending: flag,
      archived: flag,
      show_in_nav: flag,
      default_label: flag,
    },
  },
};
