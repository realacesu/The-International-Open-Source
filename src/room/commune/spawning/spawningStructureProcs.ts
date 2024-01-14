import { collectiveManager } from 'international/collective'
import {
  CreepMemoryKeys,
  ReservedCoordTypes,
  Result,
  partsByPriority,
  partsByPriorityPartType,
  RoomLogisticsRequestTypes,
  creepRoles,
  customColors,
  MovedTypes,
} from 'international/constants'
import { statsManager } from 'international/statsManager'
import { unpackPosAt, packCoord, unpackCoord } from 'other/codec'
import { creepProcs } from 'room/creeps/creepProcs'
import { structureUtils } from 'room/structureUtils'
import { SpawnRequest, BodyPartCounts, SpawnRequestTypes } from 'types/spawnRequest'
import { customLog, LogTypes } from 'utils/logging'
import { getRange, findAdjacentCoordsToCoord, utils } from 'utils/utils'
import { SpawnRequestConstructor, spawnRequestConstructors } from './spawnRequestConstructors'
import { spawningStructureUtils } from './spawningStructureUtils'
import { communeUtils } from '../communeUtils'

export class SpawningStructureProcs {
  public tryRunSpawning(room: Room) {
    const spawns = room.roomManager.structures.spawn
    if (!spawns.length) return

    this.test(room)

    // There are no spawns that we can spawn with (they are probably spawning something)
    const organizedSpawns = communeUtils.getOrganizedSpawns(room, spawns)
    if (!organizedSpawns) return

    this.registerSpawningCreeps(room, organizedSpawns.activeSpawns)

    // If all spawns are occupied, there is nothing for us to do
    if (!organizedSpawns.inactiveSpawns.length) {
      return
    }

    this.runSpawning(room, organizedSpawns.inactiveSpawns)
  }

  private runSpawning(room: Room, inactiveSpawns: StructureSpawn[]) {
    const spawnRequestsArgs = room.communeManager.spawnRequestsManager.run()

    for (const requestArgs of spawnRequestsArgs) {
      const spawnRequests = spawnRequestConstructorsByType[requestArgs.type](room, requestArgs)

      // Loop through priorities inside requestsByPriority

      for (const spawnRequest of spawnRequests) {
        if (this.runSpawnRequest(room, inactiveSpawns, spawnRequest) !== Result.success) return
      }
    }
  }

  private registerSpawningCreeps(room: Room, activeSpawns: StructureSpawn[]) {
    for (const spawn of activeSpawns) {
      const creep = Game.creeps[spawn.spawning.name]
      creepProcs.registerSpawning(creep, spawn)
      creep.spawnID = spawn.id

      if (
        spawn.spawning.remainingTime <= 2 &&
        creep.memory[CreepMemoryKeys.path] &&
        creep.memory[CreepMemoryKeys.path].length
      ) {
        const coord = unpackPosAt(creep.memory[CreepMemoryKeys.path])
        room.roomManager.reservedCoords.set(packCoord(coord), ReservedCoordTypes.spawning)
        creep.assignMoveRequest(coord)
      }
    }
  }

  private runSpawnRequest(
    room: Room,
    inactiveSpawns: StructureSpawn[],
    request: SpawnRequest,
  ): Result {
    // We're trying to build a creep larger than this room can spawn
    // If this is ran then there is a bug in spawnRequest creation

    if (request.cost > room.energyCapacityAvailable) {
      customLog(
        'Failed to spawn: not enough energy',
        `cost greater then energyCapacityAvailable, role: ${request.role}, cost: ${
          room.energyCapacityAvailable
        } / ${request.cost}, body: ${JSON.stringify(request.bodyPartCounts)}`,
        {
          type: LogTypes.warning,
        },
      )

      return Result.fail
    }

    if (request.cost > room.communeManager.nextSpawnEnergyAvailable) {
      customLog(
        'Failed to spawn: not enough energy',
        `cost greater then nextSpawnEnergyAvailable, role: ${request.role}, cost: ${
          request.cost
        } / ${room.communeManager.nextSpawnEnergyAvailable}, body: ${JSON.stringify(
          request.bodyPartCounts,
        )}`,
        {
          type: LogTypes.warning,
        },
      )
      return Result.fail
    }

    const body = this.constructBodyFromSpawnRequest(request.role, request.bodyPartCounts)

    // Try to find inactive spawn, if can't, stop the loop

    const spawnIndex = this.findSpawnIndexForSpawnRequest(inactiveSpawns, request)
    const spawn = inactiveSpawns[spawnIndex]
    const ID = collectiveManager.newCustomCreepID()

    // See if creep can be spawned

    const testSpawnResult = this.testSpawn(spawn, body, ID)

    // If creep can't be spawned

    if (testSpawnResult !== OK) {
      if (testSpawnResult === ERR_NOT_ENOUGH_ENERGY) {
        customLog(
          'Failed to spawn: dryrun failed',
          `request: ${testSpawnResult}, role: ${request.role}, cost: ${request.cost} / ${room.communeManager.nextSpawnEnergyAvailable}, body: (${body.length}) ${body}`,
          {
            type: LogTypes.error,
          },
        )
        return Result.fail
      }

      customLog(
        'Failed to spawn: dryrun failed',
        `request: ${testSpawnResult}, role: ${request.role}, cost: ${request.cost} / ${room.communeManager.nextSpawnEnergyAvailable}, body: (${body.length}) ${body}`,
        {
          type: LogTypes.error,
        },
      )

      return Result.fail
    }

    // Spawn the creep for real

    request.extraOpts.directions = this.findDirections(room, spawn.pos)
    const result = this.advancedSpawn(spawn, request, body, ID)
    if (result !== OK) {
      customLog(
        'Failed to spawn: spawning failed',
        `error: ${result}, request: ${global.debugUtils.stringify(request)}`,
        {
          type: LogTypes.error,
          position: 3,
        },
      )

      return Result.fail
    }

    // Otherwise we succeeded
    // Record in stats the costs

    room.communeManager.nextSpawnEnergyAvailable -= request.cost
    statsManager.updateStat(room.name, 'eosp', request.cost)

    // The spawn we intented to spawn should no longer be considered inactive
    inactiveSpawns.splice(spawnIndex, 1)

    // We probably used up the last remaining inactive spawn, so don't try again this tick
    if (!inactiveSpawns.length) return Result.stop

    return Result.success
  }

  private findSpawnIndexForSpawnRequest(inactiveSpawns: StructureSpawn[], request: SpawnRequest) {
    if (request.spawnTarget) {
      const [score, index] = utils.findIndexWithLowestScore(inactiveSpawns, spawn => {
        return getRange(spawn.pos, request.spawnTarget)
      })

      return index
    }

    return 0
  }

  private constructBodyFromSpawnRequest(role: CreepRoles, bodyPartCounts: BodyPartCounts) {
    let body: BodyPartConstant[] = []

    if (role === 'hauler') {
      const ratio = (bodyPartCounts[CARRY] + bodyPartCounts[WORK]) / bodyPartCounts[MOVE]

      for (let i = -1; i < bodyPartCounts[CARRY] - 1; i++) {
        body.push(CARRY)
        if (i % ratio === 0) body.push(MOVE)
      }

      for (let i = -1; i < bodyPartCounts[WORK] - 1; i++) {
        body.push(WORK)
        if (i % ratio === 0) body.push(MOVE)
      }

      return body
    }

    const endParts: BodyPartConstant[] = []

    for (const partIndex in partsByPriority) {
      const partType = partsByPriority[partIndex]
      const part = partsByPriorityPartType[partType]

      if (!bodyPartCounts[part]) continue

      let skipEndPart: boolean

      let priorityPartsCount: number
      if (partType === RANGED_ATTACK) {
        priorityPartsCount = bodyPartCounts[part]
        skipEndPart = true
      } else if (partType === ATTACK || partType === TOUGH) {
        priorityPartsCount = Math.ceil(bodyPartCounts[part] / 2)
        skipEndPart = true
      } else if (partType === 'secondaryTough' || partType === 'secondaryAttack') {
        priorityPartsCount = Math.floor(bodyPartCounts[part] / 2)
        skipEndPart = true
      } else priorityPartsCount = bodyPartCounts[part] - 1

      for (let i = 0; i < priorityPartsCount; i++) {
        body.push(part)
      }

      if (skipEndPart) continue

      // Ensure each part besides tough has a place at the end to reduce CPU when creeps perform actions
      endParts.push(part)
    }

    body = body.concat(endParts)
    return body
  }

  private findDirections(room: Room, pos: RoomPosition) {
    const anchor = room.roomManager.anchor
    if (!anchor) throw Error('No anchor for spawning structures ' + room.name)

    const adjacentCoords = findAdjacentCoordsToCoord(pos)

    // Sort by distance from the first pos in the path

    adjacentCoords.sort((a, b) => {
      return getRange(a, anchor) - getRange(b, anchor)
    })
    adjacentCoords.reverse()

    const directions: DirectionConstant[] = []

    for (const coord of adjacentCoords) {
      directions.push(pos.getDirectionTo(coord.x, coord.y))
    }

    return directions
  }

  private testSpawn(spawn: StructureSpawn, body: BodyPartConstant[], requestID: number) {
    return spawn.spawnCreep(body, requestID.toString(), { dryRun: true })
  }

  private advancedSpawn(
    spawn: StructureSpawn,
    spawnRequest: SpawnRequest,
    body: BodyPartConstant[],
    requestID: number,
  ) {
    const creepName = `${creepRoles.indexOf(spawnRequest.role)}_${spawn.room.name}_${requestID}`

    spawnRequest.extraOpts.energyStructures = spawn.room.communeManager.spawningStructuresByPriority

    spawnRequest.extraOpts.memory[CreepMemoryKeys.defaultParts] = spawnRequest.defaultParts
    spawnRequest.extraOpts.memory[CreepMemoryKeys.cost] = spawnRequest.cost

    const spawnResult = spawn.spawnCreep(body, creepName, spawnRequest.extraOpts)
    return spawnResult
  }

  createPowerTasks(room: Room) {
    if (!room.myPowerCreeps.length) return

    // There is a vivid benefit to powering spawns

    const organizedSpawns = communeUtils.getOrganizedSpawns(room)
    // We need spawns if we want to power them
    if (!organizedSpawns) return
    // Make sure there are no inactive spawns
    if (organizedSpawns.inactiveSpawns.length) return

    for (const spawn of organizedSpawns.activeSpawns) {
      room.createPowerTask(spawn, PWR_OPERATE_SPAWN, 2)
    }
  }

  createRoomLogisticsRequests(room: Room) {
    // If all spawning structures are 100% filled, no need to go further
    if (room.energyAvailable === room.energyCapacityAvailable) return

    for (const structure of room.communeManager.spawningStructuresByNeed) {
      room.createRoomLogisticsRequest({
        target: structure,
        type: RoomLogisticsRequestTypes.transfer,
        priority: 3,
      })
    }
  }

  /**
   * Spawn request debugging
   */
  private test(room: Room) {
    /*
  const args = room.communeManager.spawnRequestsManager.run()
  stringifyLog('spawn request args', args)
  stringifyLog('request', spawnRequestConstructorsByType[requestArgs.type](room, args[0]))
*/
    return

    this.testArgs(room)
    this.testRequests()
  }

  private testArgs(room: Room) {
    const spawnRequestsArgs = room.communeManager.spawnRequestsManager.run()

    for (const request of spawnRequestsArgs) {
      if (request.role === 'remoteSourceHarvester') {
        customLog(
          'SPAWN REQUEST ARGS',
          request.role + request.memoryAdditions[CreepMemoryKeys.remote] + ', ' + request.priority,
        )
        continue
      }
      customLog('SPAWN REQUEST ARGS', request.role + ', ' + request.priority)
    }
  }

  private testRequests() {}

  tryRegisterSpawningMovement(room: Room) {
    const organizedSpawns = communeUtils.getOrganizedSpawns(room)
    if (!organizedSpawns) return

    // For every spawn spawning a creep, register their movement intentions

    for (const spawn of organizedSpawns.activeSpawns) {
      const creep = Game.creeps[spawn.spawning.name]

      if (!creep.moveRequest) continue
      if (!room.moveRequests[creep.moveRequest]) {
        creep.moved = MovedTypes.moved
        continue
      }

      room.roomManager.recurseMoveRequestOrder += 1

      const creepNameAtPos =
        room.creepPositions[creep.moveRequest] || room.powerCreepPositions[creep.moveRequest]
      if (!creepNameAtPos) {
        creep.moved = creep.moveRequest
        delete room.moveRequests[creep.moveRequest]

        if (global.settings.roomVisuals) {
          const moved = unpackCoord(creep.moved)

          room.visual.rect(moved.x - 0.5, moved.y - 0.5, 1, 1, {
            fill: customColors.black,
            opacity: 0.7,
          })
        }
        continue
      }

      // There is a creep at the position
      // just get us space to move into

      const creepAtPos = Game.creeps[creepNameAtPos] || Game.powerCreeps[creepNameAtPos]
      const packedCoord = packCoord(creep.pos)

      if (global.settings.roomVisuals) {
        const moved = unpackCoord(creep.moveRequest)

        room.visual.rect(moved.x - 0.5, moved.y - 0.5, 1, 1, {
          fill: customColors.pink,
          opacity: 0.7,
        })
      }

      if (creepAtPos.shove(new Set([packedCoord]))) {
        creep.room.errorVisual(unpackCoord(creep.moveRequest))

        creep.moved = creep.moveRequest
        delete room.moveRequests[creep.moved]
        delete creep.moveRequest
      }

      continue
    }
  }
}
export const spawningStructureProcs = new SpawningStructureProcs()

export interface OrganizedSpawns {
  activeSpawns: StructureSpawn[]
  inactiveSpawns: StructureSpawn[]
}

export const spawnRequestConstructorsByType: {
  [key in SpawnRequestTypes]: SpawnRequestConstructor
} = {
  [SpawnRequestTypes.individualUniform]: spawnRequestConstructors.spawnRequestIndividualUniform,
  [SpawnRequestTypes.groupDiverse]: spawnRequestConstructors.spawnRequestGroupDiverse,
  [SpawnRequestTypes.groupUniform]: spawnRequestConstructors.spawnRequestGroupUniform,
}
