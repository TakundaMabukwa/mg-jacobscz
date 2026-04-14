import { ChannelsEnum, Pingram } from "pingram"
import { env, requirePingramApiKey } from "@/lib/env"
import { createServiceRoleClient } from "@/lib/supabase/service-role"

type AllocationSmsInput = {
  driverId: string
  vehicleId: string
  effectiveFrom?: string | null
}

type MoveOnSmsInput = {
  driverId: string
  toNumber: string
  effectiveFrom?: string | null
}

let pingramClient: Pingram | null = null

function getPingramClient() {
  if (!pingramClient) {
    pingramClient = new Pingram({
      apiKey: requirePingramApiKey(),
      baseUrl: env.pingramBaseUrl || undefined,
    })
  }

  return pingramClient
}

function serializeError(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      cause: error.cause,
    }
  }

  return error
}

function normalizePhoneNumber(value: string | null | undefined) {
  if (!value) return null

  const digits = value.replace(/[^\d+]/g, "")

  if (!digits) return null
  if (digits.startsWith("+270")) return `+27${digits.slice(4)}`
  if (digits.startsWith("+")) return digits
  if (digits.startsWith("00")) return `+${digits.slice(2)}`
  if (digits.startsWith("27")) return `+${digits}`
  if (digits.startsWith("0")) return `+27${digits.slice(1)}`

  return null
}

function formatStartDate(value?: string | null) {
  const source = value && value.trim().length > 0 ? value : new Date().toISOString().slice(0, 10)
  const parsed = new Date(`${source}T00:00:00`)

  return new Intl.DateTimeFormat("en-ZA", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "Africa/Johannesburg",
  }).format(parsed)
}

export async function sendDriverAllocationSms(input: AllocationSmsInput) {
  if (!env.pingramApiKey) {
    return
  }

  const supabase = createServiceRoleClient()

  const [{ data: driver, error: driverError }, { data: vehicle, error: vehicleError }] =
    await Promise.all([
      supabase
        .from("drivers")
        .select("id, driver_code, first_name, surname, display_name, cell_number")
        .eq("id", input.driverId)
        .maybeSingle(),
      supabase
        .from("vehiclesc")
        .select("id, vehicle_number, registration_number")
        .eq("id", input.vehicleId)
        .maybeSingle(),
    ])

  if (driverError) throw driverError
  if (vehicleError) throw vehicleError
  if (!driver || !vehicle) return

  const phoneNumber = normalizePhoneNumber(driver.cell_number as string | null | undefined)
  if (!phoneNumber) {
    console.warn(`Skipping Pingram SMS for driver ${driver.id}: no valid cell number`)
    return
  }

  const driverName =
    (typeof driver.display_name === "string" && driver.display_name.trim().length > 0
      ? driver.display_name
      : `${driver.first_name ?? ""} ${driver.surname ?? ""}`.trim()) || `Driver ${driver.driver_code ?? ""}`.trim()

  const vehicleLabel = [vehicle.vehicle_number, vehicle.registration_number].filter(Boolean).join(" - ")
  const startDate = formatStartDate(input.effectiveFrom)

  try {
    const result = await getPingramClient().send({
      type: "driver_allocation_sms",
      to: {
        id: String(driver.id),
        number: phoneNumber,
      },
      forceChannels: [ChannelsEnum.SMS],
      sms: {
        message: `MetaLoad: ${driverName}, you have been allocated to ${vehicleLabel}. Your start date is ${startDate}.`,
      },
    })

    console.log("Pingram allocation SMS response", {
      trackingId: result.trackingId,
      messages: result.messages,
      driverId: String(driver.id),
      phoneNumber,
      payload: {
        type: "driver_allocation_sms",
        vehicleLabel,
        startDate,
      },
    })

    if (!result.messages?.length) {
      console.warn("Pingram allocation SMS returned no outbound messages", {
        trackingId: result.trackingId,
        driverId: String(driver.id),
        phoneNumber,
      })
    }
  } catch (error) {
    console.error("Pingram allocation SMS error", {
      driverId: String(driver.id),
      phoneNumber,
      vehicleLabel,
      startDate,
      error: serializeError(error),
    })
    throw error
  }
}

export async function sendDriverMovedOnSms(input: MoveOnSmsInput) {
  if (!env.pingramApiKey) {
    return
  }

  const supabase = createServiceRoleClient()
  const { data: driver, error: driverError } = await supabase
    .from("drivers")
    .select("id, driver_code, first_name, surname, display_name")
    .eq("id", input.driverId)
    .maybeSingle()

  if (driverError) throw driverError
  if (!driver) return

  const phoneNumber = normalizePhoneNumber(input.toNumber)
  if (!phoneNumber) {
    console.warn(`Skipping Pingram move-on SMS for driver ${input.driverId}: invalid destination number`)
    return
  }

  const driverName =
    (typeof driver.display_name === "string" && driver.display_name.trim().length > 0
      ? driver.display_name
      : `${driver.first_name ?? ""} ${driver.surname ?? ""}`.trim()) || `Driver ${driver.driver_code ?? ""}`.trim()

  const startDate = formatStartDate(input.effectiveFrom)

  try {
    const result = await getPingramClient().send({
      type: "driver_move_on_sms",
      to: {
        id: `${driver.id}-move-on`,
        number: phoneNumber,
      },
      forceChannels: [ChannelsEnum.SMS],
      sms: {
        message: `MetaLoad: ${driverName} has been moved on. Start date is ${startDate}.`,
      },
    })

    console.log("Pingram move-on SMS response", {
      trackingId: result.trackingId,
      messages: result.messages,
      driverId: String(driver.id),
      phoneNumber,
      payload: {
        type: "driver_move_on_sms",
        startDate,
      },
    })

    if (!result.messages?.length) {
      console.warn("Pingram move-on SMS returned no outbound messages", {
        trackingId: result.trackingId,
        driverId: String(driver.id),
        phoneNumber,
      })
    }
  } catch (error) {
    console.error("Pingram move-on SMS error", {
      driverId: String(driver.id),
      phoneNumber,
      startDate,
      error: serializeError(error),
    })
    throw error
  }
}
