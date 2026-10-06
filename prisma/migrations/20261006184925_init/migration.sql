-- CreateTable
CREATE TABLE "Province" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "Province_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "District" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "provinceId" INTEGER NOT NULL,

    CONSTRAINT "District_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GridSubstation" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "districtId" INTEGER NOT NULL,

    CONSTRAINT "GridSubstation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SolarInstallation" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "meterId" TEXT NOT NULL,
    "substationId" INTEGER NOT NULL,

    CONSTRAINT "SolarInstallation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GenerationReading" (
    "id" SERIAL NOT NULL,
    "installationId" INTEGER NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "powerKw" DOUBLE PRECISION NOT NULL,
    "energyKwh" DOUBLE PRECISION NOT NULL,
    "voltage" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "GenerationReading_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "jurisdiction" TEXT NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Province_name_key" ON "Province"("name");

-- CreateIndex
CREATE UNIQUE INDEX "District_name_provinceId_key" ON "District"("name", "provinceId");

-- CreateIndex
CREATE UNIQUE INDEX "GridSubstation_name_districtId_key" ON "GridSubstation"("name", "districtId");

-- CreateIndex
CREATE UNIQUE INDEX "SolarInstallation_meterId_key" ON "SolarInstallation"("meterId");

-- CreateIndex
CREATE INDEX "GenerationReading_installationId_timestamp_idx" ON "GenerationReading"("installationId", "timestamp");

-- AddForeignKey
ALTER TABLE "District" ADD CONSTRAINT "District_provinceId_fkey" FOREIGN KEY ("provinceId") REFERENCES "Province"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GridSubstation" ADD CONSTRAINT "GridSubstation_districtId_fkey" FOREIGN KEY ("districtId") REFERENCES "District"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SolarInstallation" ADD CONSTRAINT "SolarInstallation_substationId_fkey" FOREIGN KEY ("substationId") REFERENCES "GridSubstation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GenerationReading" ADD CONSTRAINT "GenerationReading_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "SolarInstallation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
