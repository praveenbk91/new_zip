CREATE OR REPLACE VIEW AIM_FS_FTE_PROPERTY_LOC_TYPE_SQFT AS
SELECT
    ae_fs_task_groups_e.multitenant_id AS multitenant_id,
    ae_fs_task_groups_e.service_type AS service_type,
    ae_fs_task_groups_e.task_group_id AS task_group_id,
    ae_b_loc_d.region_code AS region_code,
    ae_b_loc_d.fac_id AS fac_id,
    ae_b_loc_d.bldg AS bldg,
    ae_b_loc_d.loc_type AS loc_type,
    SUM(COALESCE(ae_b_loc_d.poly_sqft, COALESCE(ae_b_loc_d.user_gross, 0))) AS sqft
FROM ae_fs_task_groups_e
INNER JOIN ae_fs_task_groups_l
    ON ae_fs_task_groups_e.multitenant_id = ae_fs_task_groups_l.multitenant_id
    AND ae_fs_task_groups_e.task_group_id = ae_fs_task_groups_l.task_group_id
INNER JOIN ae_b_loc_d
    ON ae_fs_task_groups_l.multitenant_id = ae_b_loc_d.multitenant_id
    AND ae_fs_task_groups_l.loc_type = ae_b_loc_d.loc_type
    AND ae_fs_task_groups_e.floor_type = ae_b_loc_d.floor_type
    AND ae_fs_task_groups_e.heavy_use = ae_b_loc_d.heavy_use
INNER JOIN ae_b_loc_s
    ON ae_b_loc_d.multitenant_id = ae_b_loc_s.multitenant_id
    AND ae_b_loc_d.loc_status = ae_b_loc_s.loc_status
    AND ae_b_loc_s.complete_yn = 'N'
INNER JOIN ae_b_lty_e
    ON ae_b_loc_d.multitenant_id = ae_b_lty_e.multitenant_id
    AND ae_b_loc_d.loc_type = ae_b_lty_e.loc_type
WHERE
    ae_fs_task_groups_e.task_group_id IN (
        'APPA-1001', 'APPA-1002', 'APPA-1003', 'APPA-1004', 'APPA-1005',
        'APPA-1006', 'APPA-1007', 'APPA-1008', 'APPA-1009', 'APPA-1010',
        'APPA-1011', 'APPA-1012', 'APPA-1013', 'APPA-1014', 'APPA-1015',
        'APPA-1016', 'APPA-1017', 'APPA-1018', 'APPA-1019', 'APPA-1020',
        'APPA-1021', 'APPA-1022', 'APPA-1023', 'APPA-1024', 'APPA-1025',
        'APPA-1026', 'APPA-1027', 'APPA-1028', 'APPA-1029', 'APPA-1030',
        'APPA-1031'
    )
    AND ae_fs_task_groups_e.active = 'Y'
GROUP BY
    ae_fs_task_groups_e.multitenant_id,
    ae_fs_task_groups_e.service_type,
    ae_fs_task_groups_e.task_group_id,
    ae_b_loc_d.region_code,
    ae_b_loc_d.fac_id,
    ae_b_loc_d.bldg,
    ae_b_loc_d.loc_type;
