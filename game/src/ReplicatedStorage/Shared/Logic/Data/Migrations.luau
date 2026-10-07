--!strict
-- Every save upgrade lives here, in order. Migrations[1] turns a version 1 save into version 2,
-- Migrations[2] turns version 2 into version 3, and so on.
-- Template.SchemaVersion must always be one more than the number of migrations, and a test checks that.
-- Each migration gets a copy of the save and changes it in place.

export type Migration = (Data: { [string]: any }) -> ()

local Migrations: { Migration } = {}

return Migrations
