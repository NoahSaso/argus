import { createHash, randomUUID } from 'crypto'

import { Op, Sequelize } from 'sequelize'
import {
  AllowNull,
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  HasMany,
  Model,
  Table,
} from 'sequelize-typescript'

import { Account } from './Account'
import { AccountKeyCredit, AccountKeyCreditApiJson } from './AccountKeyCredit'

export type AccountKeyApiJson = {
  id: number
  name: string
  description: string | null
  credits: AccountKeyCreditApiJson[]
}

@Table({
  timestamps: true,
  indexes: [
    {
      unique: true,
      fields: ['accountPublicKey', 'name'],
    },
    {
      fields: ['hashedKey'],
    },
  ],
})
export class AccountKey extends Model {
  @AllowNull(false)
  @ForeignKey(() => Account)
  @Column(DataType.STRING)
  declare accountPublicKey: string

  @BelongsTo(() => Account)
  declare account: Account

  @AllowNull(false)
  @Column(DataType.STRING)
  declare name: string

  @AllowNull
  @Column(DataType.STRING)
  declare description: string | null

  @AllowNull(false)
  @Column(DataType.STRING)
  declare hashedKey: string

  @HasMany(() => AccountKeyCredit, 'accountKeyId')
  declare credits: AccountKeyCredit[]

  public static generateKeyAndHash(): {
    key: string
    hash: string
  } {
    const key = randomUUID()
    const hash = this.hashKey(key)
    return {
      key,
      hash,
    }
  }

  public static hashKey(key: string): string {
    return createHash('sha512').update(key).digest('base64')
  }

  public static async findForKey(key: string): Promise<AccountKey | null> {
    const hashedKey = await this.hashKey(key)
    return await AccountKey.findOne({
      where: {
        hashedKey,
      },
    })
  }

  public get isTest(): boolean {
    return this.name === 'test' && this.hashedKey === AccountKey.hashKey('test')
  }

  public async getApiJson(): Promise<AccountKeyApiJson> {
    // Load credits in case they haven't been loaded yet.
    this.credits ||= (await this.$get('credits')) ?? ([] as AccountKeyCredit[])

    return {
      id: this.id,
      name: this.name,
      description: this.description,
      credits: this.credits.map((credit) => credit.apiJson),
    }
  }

  // Check if this account has compute credit, and increase used if found.
  // Returns whether credit was found and used.
  public async useCredit(
    amount = 1,
    waitForIncrement = true
  ): Promise<boolean> {
    // Find credit that has enough remaining.
    const credits =
      (await this.$get('credits', {
        where: {
          amount: {
            [Op.or]: [
              // Infinite credit.
              {
                [Op.eq]: -1,
              },
              // Has enough to cover requested amount.
              {
                [Op.gte]: Sequelize.literal(`"used" + ${amount}`),
              },
            ],
          },
        },
        // Use lowest amount first.
        order: [['amount', 'ASC']],
        limit: 1,
      })) ?? ([] as AccountKeyCredit[])

    // Use first credit found.
    const credit = credits[0]
    if (!credit) {
      return false
    }

    const promise = Promise.all([
      // Use credit amount. On failure, just log and move on.
      credit.increment('used', { by: amount }).catch((err) => {
        console.error('Error incrementing used credit', err)
      }),
      // Increment hits by one. On failure, just log and move on.
      credit.increment('hits').catch((err) => {
        console.error('Error incrementing hits credit', err)
      }),
    ])
    // Wait for the increments to complete.
    if (waitForIncrement) {
      await promise
    }

    return true
  }
}
