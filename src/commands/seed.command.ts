import { Arguments, Argv, CommandModule, exit } from 'yargs'
import ora, { Ora } from 'ora'

import { ClassConstructor } from '../types'
import { Seeder } from '../seeder'
import { SeedingSource } from '../seeding-source'
import { gray } from 'chalk'
import { importDataSource } from '../configuration/import-data-source'
import { importSeedingSource } from '../configuration/import-seeding-source'

interface SeedCommandArguments extends Arguments {
  root?: string
  dataSource?: string
  seedingSource?: string
  seed?: string
}

export class SeedCommand implements CommandModule {
  command = 'seed'
  describe = 'Runs the seeds'

  /**
   * @inheritdoc
   */
  builder(args: Argv) {
    return args
      .option('r', {
        alias: 'root',
        type: 'string',
        describe: 'Path to project root',
        default: process.cwd(),
      })
      .option('c', {
        alias: 'seedingSource',
        type: 'string',
        describe: 'Path to the SeedingSource definition file.',
      })
      .option('d', {
        alias: 'dataSource',
        type: 'string',
        describe: 'Path to the DataSource definition file. Defines or overrides DataSource.',
      })
      .option('s', {
        alias: 'seed',
        type: 'string',
        describe: 'Comma separated list of specific Seeder class(es) to run.',
      })
  }

  /**
   * @inheritdoc
   */
  async handler(args: SeedCommandArguments) {
    const spinner = ora({ text: 'Loading ormconfig', isSilent: process.env.NODE_ENV === 'test' }).start()

    // determine root path
    const rootPath = args.root && args.root[0] === '.' ? process.cwd() + '/' + args.root : args.root

    // get seeding source
    let seedingSource: SeedingSource

    // data source was requested?
    if (args.seedingSource) {
      try {
        seedingSource = await importSeedingSource(args.seedingSource, rootPath)
        spinner.succeed(`Seeding Config ${args.seedingSource} loaded`)
        await seedingSource.initialize()
        spinner.succeed(`Seeding Source initialized`)
      } catch (error) {
        return panic(spinner, error, `Could not load the seeding source config file at ${args.seedingSource}!`)
      }
    } else {
      return panic(
        spinner,
        new Error('Missing seedingSource arg'),
        `You must define a SeedingSource by providing a --seedingSource arg (see help)`,
      )
    }

    // data source was requested?
    if (args.dataSource) {
      // warn about override
      spinner.info(`Data Source Config will be overridden with ${args.dataSource}`)
      // try to import it
      try {
        // import from file
        const dataSource = await importDataSource(args.dataSource, rootPath)
        // maybe initialize
        if (!dataSource.isInitialized) {
          await dataSource.initialize()
        }
        // set it on seeding source
        seedingSource.dataSource = dataSource
        spinner.succeed(`Data Source Config ${args.dataSource} loaded`)
      } catch (error) {
        return panic(spinner, error, `Could not load the data source config file at ${args.dataSource}!`)
      }
    }

    // check if we have a data source
    if (!seedingSource.dataSource) {
      return panic(
        spinner,
        new Error('SeedingSource.dataSource is not defined'),
        `You must provide a DataSource in the SeedingSource, or provide a --dataSource arg (see help)`,
      )
    }

    // Show seeder in console
    spinner.start('Importing Seeders')

    let seeders!: ClassConstructor<Seeder>[]

    // specific seeder(s) requested?
    if (args.seed) {
      // yes, parse and attempt to import
      seeders = seedingSource.seedersFromString(args.seed)
      spinner.info(`Specific seeder(s) have been requested`)
    } else if (seedingSource.defaultSeeders) {
      // have defaults, use those
      seeders = seedingSource.defaultSeeders
      spinner.info(`Default seeders will used`)
    } else {
      // falling back to using all seeders
      seeders = seedingSource.seeders
      spinner.info(`All seeders will used`)
    }

    // here we go
    const seedersNames = seeders.map((seeder) => seeder.name).join(', ')
    spinner.start(`Executing ${seedersNames} Seeders`)

    // run seeders
    try {
      await seedingSource.initialize()
      await seedingSource.run.many(seeders)
      spinner.succeed(`Seeders ${seedersNames} executed`)
    } catch (error) {
      return panic(spinner, error, `Failed to run the ${seedersNames} seeders!`)
    } finally {
      if (seedingSource.dataSource?.isInitialized) {
        // Clean up data source so the command doesn't hang after execution
        await seedingSource.dataSource.destroy()
      }
    }

    console.log('👍 ', gray.underline(`Finished Seeding`))
    process.exit(0) // tell node we want to exit explicitly, we're done
  }
}

function panic(spinner: Ora, error: unknown, message: string) {
  const finalError = error instanceof Error ? error : new Error(String(error))
  const finalMessage = `${message} Orginal error was: ${finalError.message}`
  spinner.fail(finalMessage)
  console.error(finalMessage)
  exit(1, finalError)
}
